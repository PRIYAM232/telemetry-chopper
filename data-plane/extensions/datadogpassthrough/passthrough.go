package datadogpassthrough

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/extension"
	"go.opentelemetry.io/collector/extension/extensionmiddleware"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.uber.org/zap"
)

// meterScope names the instrumentation scope on the collector's self-telemetry
// meter, mirroring the module path like the chopper_filter processor does.
const meterScope = "github.com/PRIYAM232/telemetry-chopper/data-plane/extensions/datadogpassthrough"

// warnEvery limits the "Agent unreachable" warning to one per interval, so an
// Agent outage doesn't flood the collector log with one line per request.
const warnEvery = time.Minute

type passthrough struct {
	cfg       *Config
	logger    *zap.Logger
	target    *url.URL
	transport *http.Transport
	proxy     *httputil.ReverseProxy
	requests  metric.Int64Counter // nil when self-metrics are off
	info      agentInfoCache
	lastWarn  atomic.Int64 // unix nanos of the last unreachable warning
}

var (
	_ extension.Extension                       = (*passthrough)(nil)
	_ extensionmiddleware.HTTPServer            = (*passthrough)(nil)
	_ http.ResponseWriter                       = (*statusWriter)(nil)
	_ interface{ Unwrap() http.ResponseWriter } = (*statusWriter)(nil)
)

func newPassthrough(set extension.Settings, cfg *Config) (*passthrough, error) {
	target, socket, err := parseEndpoint(cfg.Endpoint)
	if err != nil {
		return nil, err
	}
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	dial := dialer.DialContext
	if socket != "" {
		dial = func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, "unix", socket)
		}
	}
	p := &passthrough{
		cfg:    cfg,
		logger: set.Logger,
		target: target,
		// No HTTP(S)_PROXY from the environment: the Agent is a local hop,
		// and an egress proxy meant for the internet would break it.
		transport: &http.Transport{
			DialContext:         dial,
			MaxIdleConns:        64,
			MaxIdleConnsPerHost: 16,
			IdleConnTimeout:     90 * time.Second,
			TLSHandshakeTimeout: 5 * time.Second,
		},
	}
	p.proxy = &httputil.ReverseProxy{
		// Rewrite (not Director) also strips X-Forwarded-* and hop-by-hop
		// headers; the Agent sees the tracer's own headers, such as
		// Datadog-Container-ID, unchanged.
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(p.target)
		},
		Transport:    p.transport,
		ErrorHandler: p.proxyError,
		ErrorLog:     zap.NewStdLog(set.Logger),
	}

	// Self-metrics are best-effort: losing the counter degrades
	// observability, never the forwarding.
	if mp := set.TelemetrySettings.MeterProvider; mp != nil {
		c, err := mp.Meter(meterScope).Int64Counter("otelcol_chopper_datadog_passthrough_requests",
			metric.WithDescription("Requests on the datadog receiver's port forwarded to the Datadog Agent, by Datadog product and result."),
			metric.WithUnit("{requests}"))
		if err != nil {
			set.Logger.Warn("chopper_datadog_passthrough self-metrics disabled: instrument registration failed", zap.Error(err))
		} else {
			p.requests = c
		}
	}
	return p, nil
}

func (p *passthrough) Start(context.Context, component.Host) error { return nil }

func (p *passthrough) Shutdown(context.Context) error {
	p.transport.CloseIdleConnections()
	return nil
}

// GetHTTPHandler wraps the datadog receiver's handler. confighttp calls it
// once per server that lists this extension under `middlewares`.
func (p *passthrough) GetHTTPHandler(context.Context) (extensionmiddleware.WrapHTTPHandlerFunc, error) {
	return func(_ context.Context, next http.Handler) (http.Handler, error) {
		return &handler{p: p, next: next}, nil
	}, nil
}

// handler routes one receiver's requests: what the receiver handles stays
// with it, /info is merged, and everything else goes to the Agent.
type handler struct {
	p    *passthrough
	next http.Handler

	once sync.Once
	recv receiverRoutes
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.once.Do(func() { h.recv = learnReceiver(h.next) })
	path := r.URL.Path
	switch {
	case path == "/info":
		h.serveInfo(w, r)
	case h.recv.handles(path), isTraceIntake(path):
		h.next.ServeHTTP(w, r)
	default:
		h.p.forward(w, r)
	}
}

// isTraceIntake reports whether path is one of the Agent's trace or APM stats
// intakes, in any version: /v0.4/traces, /v1.0/traces, /api/v0.2/traces,
// /v0.6/stats. These are never forwarded or advertised, even when the
// receiver doesn't handle that version: a tracer that sent traces to the
// Agent directly would bypass the rules, and one that sent client-computed
// stats would make the Agent count those requests twice.
func isTraceIntake(path string) bool {
	path = strings.TrimPrefix(path, "/api")
	if len(path) < 3 || path[0] != '/' || path[1] != 'v' {
		return false
	}
	rest := path[2:]
	i := strings.IndexByte(rest, '/')
	if i <= 0 {
		return false
	}
	for _, c := range rest[:i] {
		if (c < '0' || c > '9') && c != '.' {
			return false
		}
	}
	switch rest[i+1:] {
	case "traces", "traces/", "stats", "stats/":
		return true
	}
	return false
}

func (p *passthrough) forward(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), p.cfg.Timeout)
	defer cancel()
	sw := &statusWriter{ResponseWriter: w}
	p.proxy.ServeHTTP(sw, r.WithContext(ctx))
	if p.requests != nil {
		p.requests.Add(context.Background(), 1, metric.WithAttributes(
			attribute.String("product", product(r.URL.Path)),
			attribute.String("result", sw.result()),
		))
	}
}

// proxyError answers a request the Agent couldn't take with 502, so the
// tracer sees a failure (and retries or reports it) instead of a silent 200.
func (p *passthrough) proxyError(w http.ResponseWriter, r *http.Request, err error) {
	if sw, ok := w.(*statusWriter); ok {
		sw.failed = true
	}
	fields := []zap.Field{zap.String("path", r.URL.Path), zap.String("agent", p.cfg.Endpoint), zap.Error(err)}
	now := time.Now().UnixNano()
	if last := p.lastWarn.Load(); now-last >= int64(warnEvery) && p.lastWarn.CompareAndSwap(last, now) {
		p.logger.Warn("Datadog Agent unreachable; tracer requests other than traces are failing (traces are unaffected)", fields...)
	} else {
		p.logger.Debug("forwarding to the Datadog Agent failed", fields...)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		w.WriteHeader(http.StatusGatewayTimeout)
		return
	}
	w.WriteHeader(http.StatusBadGateway)
}

// product maps a forwarded path to the Datadog feature behind it, a bounded
// label for the requests counter.
func product(path string) string {
	switch {
	case strings.HasPrefix(path, "/profiling/"):
		return "profiling"
	case strings.HasSuffix(path, "/pipeline_stats"):
		return "data_streams"
	case strings.HasPrefix(path, "/debugger/"):
		return "dynamic_instrumentation"
	case strings.HasPrefix(path, "/symdb/"):
		return "symbol_database"
	case path == "/v0.7/config":
		return "remote_config"
	case strings.HasPrefix(path, "/telemetry/"):
		return "telemetry"
	case strings.HasPrefix(path, "/evp_proxy/"):
		return "evp_proxy"
	case strings.HasPrefix(path, "/dogstatsd/"):
		return "dogstatsd"
	case strings.HasPrefix(path, "/tracer_flare/"):
		return "tracer_flare"
	case strings.HasPrefix(path, "/openlineage/"):
		return "openlineage"
	}
	return "other"
}

// statusWriter records the status the Agent answered with.
type statusWriter struct {
	http.ResponseWriter
	status int
	failed bool
}

func (s *statusWriter) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusWriter) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

// Unwrap lets http.ResponseController reach the underlying writer's Flush.
func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

func (s *statusWriter) result() string {
	switch {
	case s.failed:
		return "unreachable"
	case s.status >= 500:
		return "5xx"
	case s.status >= 400:
		return "4xx"
	default:
		return "2xx"
	}
}
