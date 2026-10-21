package datadogpassthrough

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/collector/extension/extensiontest"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// fakeReceiver stands in for the datadog receiver's mux: trace endpoints, an
// /info listing them, and the catch-all that answers 200 and discards.
type fakeReceiver struct {
	mu        sync.Mutex
	traces    int
	discarded []string
}

func (f *fakeReceiver) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.discarded = append(f.discarded, r.URL.Path)
		f.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	})
	for _, p := range []string{"/v0.3/traces", "/v0.4/traces", "/v0.5/traces", "/v0.7/traces", "/api/v0.2/traces"} {
		mux.HandleFunc(p, func(w http.ResponseWriter, _ *http.Request) {
			f.mu.Lock()
			f.traces++
			f.mu.Unlock()
			_, _ = io.WriteString(w, "{}")
		})
	}
	mux.HandleFunc("/info", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"version":"datadogreceiver-otelcol-chopper-0.1.0","endpoints":["/","/v0.3/traces","/v0.4/traces","/v0.5/traces","/v0.7/traces","/api/v0.2/traces"],"client_drop_p0s":false,"span_meta_structs":false,"long_running_spans":false}`)
	})
	return mux
}

// agentInfo is a trimmed Agent 7.84 /info answer.
const agentInfo = `{
 "version": "7.84.4",
 "endpoints": ["/v0.3/traces", "/v0.4/traces", "/v0.5/traces", "/v0.7/traces", "/v1.0/traces",
   "/profiling/v1/input", "/telemetry/proxy/", "/v0.6/stats", "/v0.1/pipeline_stats",
   "/evp_proxy/v4/", "/debugger/v1/input", "/v0.7/config"],
 "client_drop_p0s": true,
 "span_events": true,
 "evp_proxy_allowed_headers": ["Content-Type", "DD-EVP-ORIGIN"],
 "peer_tags": ["peer.service"],
 "config": {"default_env": "prod", "statsd_port": 8125}
}`

type agentRequest struct {
	method, path, query, body string
	header                    http.Header
}

// fakeAgent records what reaches the Agent.
type fakeAgent struct {
	mu       sync.Mutex
	requests []agentRequest
}

func (a *fakeAgent) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/info" {
			_, _ = io.WriteString(w, agentInfo)
			return
		}
		body, _ := io.ReadAll(r.Body)
		a.mu.Lock()
		a.requests = append(a.requests, agentRequest{r.Method, r.URL.Path, r.URL.RawQuery, string(body), r.Header.Clone()})
		a.mu.Unlock()
		w.Header().Set("X-Agent", "yes")
		w.WriteHeader(http.StatusAccepted)
		_, _ = io.WriteString(w, `{"agent":true}`)
	})
}

func (a *fakeAgent) paths() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	var out []string
	for _, r := range a.requests {
		out = append(out, r.path)
	}
	return out
}

// newTestHandler wraps a fake receiver with the middleware pointed at endpoint.
func newTestHandler(t *testing.T, endpoint string, timeout time.Duration, reader sdkmetric.Reader) (*fakeReceiver, http.Handler) {
	t.Helper()
	set := extensiontest.NewNopSettings(Type)
	if reader != nil {
		set.TelemetrySettings.MeterProvider = sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	}
	cfg := &Config{Endpoint: endpoint, Timeout: timeout}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	ext, err := NewFactory().Create(context.Background(), set, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ext.Shutdown(context.Background()) })
	wrap, err := ext.(*passthrough).GetHTTPHandler(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	recv := &fakeReceiver{}
	h, err := wrap(context.Background(), recv.handler())
	if err != nil {
		t.Fatal(err)
	}
	return recv, h
}

func do(h http.Handler, method, target, body string, header map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	for k, v := range header {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestForwardsWhatTheReceiverDoesNotHandle(t *testing.T) {
	agent := &fakeAgent{}
	srv := httptest.NewServer(agent.handler())
	defer srv.Close()
	recv, h := newTestHandler(t, srv.URL, 5*time.Second, nil)

	for _, path := range []string{
		"/profiling/v1/input?foo=bar",
		"/v0.1/pipeline_stats",
		"/debugger/v1/input",
		"/v0.7/config",
		"/telemetry/proxy/api/v2/apmtelemetry",
		"/evp_proxy/v4/api/v2/llmobs",
		"/symdb/v1/input",
		"/tracer_flare/v1",
	} {
		rec := do(h, http.MethodPost, path, "payload:"+path, map[string]string{
			"Content-Type":         "multipart/form-data; boundary=x",
			"Datadog-Container-ID": "abc123",
			"DD-EVP-ORIGIN":        "llmobs",
		})
		if rec.Code != http.StatusAccepted || rec.Header().Get("X-Agent") != "yes" || rec.Body.String() != `{"agent":true}` {
			t.Errorf("%s: got %d %q, want the Agent's 202 answer", path, rec.Code, rec.Body.String())
		}
	}

	agent.mu.Lock()
	defer agent.mu.Unlock()
	if len(agent.requests) != 8 {
		t.Fatalf("Agent got %d requests, want 8", len(agent.requests))
	}
	first := agent.requests[0]
	if first.path != "/profiling/v1/input" || first.query != "foo=bar" || first.body != "payload:/profiling/v1/input?foo=bar" {
		t.Errorf("profile request arrived as %+v", first)
	}
	if first.header.Get("Datadog-Container-ID") != "abc123" || first.header.Get("Content-Type") != "multipart/form-data; boundary=x" {
		t.Errorf("tracer headers not passed on: %v", first.header)
	}
	if first.header.Get("X-Forwarded-For") != "" {
		t.Errorf("X-Forwarded-For added: %q", first.header.Get("X-Forwarded-For"))
	}
	if len(recv.discarded) != 0 {
		t.Errorf("receiver catch-all still got %v", recv.discarded)
	}
}

func TestTraceIntakesStayWithTheReceiver(t *testing.T) {
	agent := &fakeAgent{}
	srv := httptest.NewServer(agent.handler())
	defer srv.Close()
	recv, h := newTestHandler(t, srv.URL, 5*time.Second, nil)

	for _, path := range []string{"/v0.3/traces", "/v0.4/traces", "/v0.5/traces", "/v0.7/traces", "/api/v0.2/traces"} {
		if rec := do(h, http.MethodPut, path, "x", nil); rec.Code != http.StatusOK {
			t.Errorf("%s: %d", path, rec.Code)
		}
	}
	// Trace and stats intakes the receiver lacks go to its catch-all, never to
	// the Agent: that would bypass the rules or double-count trace metrics.
	for _, path := range []string{"/v1.0/traces", "/v0.6/stats", "/api/v0.2/stats", "/v0.4/traces/"} {
		do(h, http.MethodPut, path, "x", nil)
	}
	if recv.traces != 5 {
		t.Errorf("receiver handled %d trace requests, want 5", recv.traces)
	}
	if got := agent.paths(); len(got) != 0 {
		t.Errorf("Agent got %v, want nothing", got)
	}
	want := []string{"/v1.0/traces", "/v0.6/stats", "/api/v0.2/stats", "/v0.4/traces/"}
	if !slices.Equal(recv.discarded, want) {
		t.Errorf("catch-all got %v, want %v", recv.discarded, want)
	}
}

func TestAgentDownFailsOnlyForwardedRequests(t *testing.T) {
	// A port nothing listens on.
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	endpoint := "http://" + l.Addr().String()
	_ = l.Close()

	reader := sdkmetric.NewManualReader()
	recv, h := newTestHandler(t, endpoint, 5*time.Second, reader)

	if rec := do(h, http.MethodPost, "/profiling/v1/input", "p", nil); rec.Code != http.StatusBadGateway {
		t.Errorf("profile with the Agent down: %d, want 502", rec.Code)
	}
	if rec := do(h, http.MethodPut, "/v0.4/traces", "t", nil); rec.Code != http.StatusOK || recv.traces != 1 {
		t.Errorf("traces with the Agent down: %d, %d handled", rec.Code, recv.traces)
	}
	// /info falls back to the receiver's own answer.
	rec := do(h, http.MethodGet, "/info", "", nil)
	var info struct {
		Endpoints []string `json:"endpoints"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &info); err != nil || slices.Contains(info.Endpoints, "/profiling/v1/input") {
		t.Errorf("/info with the Agent down: %v %s", err, rec.Body.String())
	}
	if got := counterPoints(t, reader); got["profiling/unreachable"] != 1 {
		t.Errorf("requests counter = %v, want profiling/unreachable 1", got)
	}
}

func TestSlowAgentTimesOut(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(release)
	_, h := newTestHandler(t, srv.URL, 50*time.Millisecond, nil)

	start := time.Now()
	if rec := do(h, http.MethodPost, "/v0.1/pipeline_stats", "s", nil); rec.Code != http.StatusGatewayTimeout {
		t.Errorf("slow Agent: %d, want 504", rec.Code)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("timeout took %s", d)
	}
}

func TestInfoAdvertisesForwardedFeatures(t *testing.T) {
	agent := &fakeAgent{}
	srv := httptest.NewServer(agent.handler())
	defer srv.Close()
	_, h := newTestHandler(t, srv.URL, 5*time.Second, nil)

	rec := do(h, http.MethodGet, "/info", "", nil)
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("/info: %d %v", rec.Code, rec.Header())
	}
	var info map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &info); err != nil {
		t.Fatal(err)
	}
	var endpoints []string
	for _, e := range info["endpoints"].([]any) {
		endpoints = append(endpoints, e.(string))
	}
	want := []string{
		"/v0.3/traces", "/v0.4/traces", "/v0.5/traces", "/v0.7/traces", "/api/v0.2/traces",
		"/profiling/v1/input", "/telemetry/proxy/", "/v0.1/pipeline_stats", "/evp_proxy/v4/", "/debugger/v1/input", "/v0.7/config",
	}
	if !slices.Equal(endpoints, want) {
		t.Errorf("endpoints = %v\nwant %v", endpoints, want)
	}
	// Trace behavior stays the receiver's: no client-side P0 dropping, no
	// native span events.
	if info["client_drop_p0s"] != false || info["span_events"] != nil || info["peer_tags"] != nil {
		t.Errorf("trace capabilities taken from the Agent: %v", info)
	}
	if !strings.HasPrefix(info["version"].(string), "datadogreceiver-") {
		t.Errorf("version = %v", info["version"])
	}
	if cfg, _ := info["config"].(map[string]any); cfg["default_env"] != "prod" {
		t.Errorf("config not copied: %v", info["config"])
	}
	if info["evp_proxy_allowed_headers"] == nil {
		t.Error("evp_proxy_allowed_headers not copied")
	}
}

func TestUnixSocketEndpoint(t *testing.T) {
	dir, err := os.MkdirTemp("", "ddp")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	sock := filepath.Join(dir, "apm.socket")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Skipf("unix sockets unavailable: %v", err)
	}
	agent := &fakeAgent{}
	srv := &http.Server{Handler: agent.handler()}
	go func() { _ = srv.Serve(l) }()
	defer srv.Close()

	_, h := newTestHandler(t, "unix://"+sock, 5*time.Second, nil)
	if rec := do(h, http.MethodPost, "/v0.7/config", "{}", nil); rec.Code != http.StatusAccepted {
		t.Errorf("over a unix socket: %d", rec.Code)
	}
	if got := agent.paths(); !slices.Equal(got, []string{"/v0.7/config"}) {
		t.Errorf("Agent got %v", got)
	}
}

func TestRequestsCounter(t *testing.T) {
	agent := &fakeAgent{}
	srv := httptest.NewServer(agent.handler())
	defer srv.Close()
	reader := sdkmetric.NewManualReader()
	_, h := newTestHandler(t, srv.URL, 5*time.Second, reader)

	do(h, http.MethodPost, "/profiling/v1/input", "p", nil)
	do(h, http.MethodPost, "/profiling/v1/input", "p", nil)
	do(h, http.MethodPost, "/v0.7/config", "c", nil)
	do(h, http.MethodPut, "/v0.4/traces", "t", nil) // not forwarded, not counted

	got := counterPoints(t, reader)
	want := map[string]int64{"profiling/2xx": 2, "remote_config/2xx": 1}
	if len(got) != len(want) || got["profiling/2xx"] != 2 || got["remote_config/2xx"] != 1 {
		t.Errorf("requests counter = %v, want %v", got, want)
	}
}

// counterPoints returns the requests counter as "product/result" → value.
func counterPoints(t *testing.T, reader sdkmetric.Reader) map[string]int64 {
	t.Helper()
	var rm metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &rm); err != nil {
		t.Fatal(err)
	}
	out := map[string]int64{}
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name != "otelcol_chopper_datadog_passthrough_requests" {
				continue
			}
			for _, dp := range m.Data.(metricdata.Sum[int64]).DataPoints {
				p, _ := dp.Attributes.Value("product")
				r, _ := dp.Attributes.Value("result")
				out[p.AsString()+"/"+r.AsString()] = dp.Value
			}
		}
	}
	return out
}

func TestRewrittenByDecompressor(t *testing.T) {
	sized := httptest.NewRequest(http.MethodPost, "/v0.1/pipeline_stats", strings.NewReader("x"))
	chunked := httptest.NewRequest(http.MethodPost, "/v0.1/pipeline_stats", nil)
	chunked.ContentLength, chunked.TransferEncoding = -1, []string{"chunked"}
	decompressed := httptest.NewRequest(http.MethodPost, "/v0.1/pipeline_stats", nil)
	decompressed.ContentLength = -1
	h2 := httptest.NewRequest(http.MethodPost, "/v0.1/pipeline_stats", nil)
	h2.ContentLength, h2.ProtoMajor = -1, 2
	for name, tc := range map[string]struct {
		r    *http.Request
		want bool
	}{"sized": {sized, false}, "chunked": {chunked, false}, "decompressed": {decompressed, true}, "http2": {h2, false}} {
		if got := rewrittenByDecompressor(tc.r); got != tc.want {
			t.Errorf("%s: %v, want %v", name, got, tc.want)
		}
	}
}

func TestIsTraceIntake(t *testing.T) {
	for path, want := range map[string]bool{
		"/v0.3/traces":                true,
		"/v0.4/traces":                true,
		"/v1.0/traces":                true,
		"/v0.4/traces/":               true,
		"/api/v0.2/traces":            true,
		"/v0.6/stats":                 true,
		"/api/v0.2/stats":             true,
		"/v0.1/pipeline_stats":        false,
		"/v0.3/services":              false,
		"/v0.7/config":                false,
		"/profiling/v1/input":         false,
		"/evp_proxy/v2/api/v2/traces": false,
		"/vx/traces":                  false,
		"/v/traces":                   false,
		"/info":                       false,
		"/":                           false,
	} {
		if got := isTraceIntake(path); got != want {
			t.Errorf("isTraceIntake(%q) = %v, want %v", path, got, want)
		}
	}
}

func TestProduct(t *testing.T) {
	for path, want := range map[string]string{
		"/profiling/v1/input":                  "profiling",
		"/v0.1/pipeline_stats":                 "data_streams",
		"/debugger/v1/diagnostics":             "dynamic_instrumentation",
		"/symdb/v1/input":                      "symbol_database",
		"/v0.7/config":                         "remote_config",
		"/telemetry/proxy/api/v2/apmtelemetry": "telemetry",
		"/evp_proxy/v2/api/v2/citestcycle":     "evp_proxy",
		"/dogstatsd/v2/proxy":                  "dogstatsd",
		"/tracer_flare/v1":                     "tracer_flare",
		"/openlineage/api/v1/lineage":          "openlineage",
		"/config/set":                          "other",
	} {
		if got := product(path); got != want {
			t.Errorf("product(%q) = %q, want %q", path, got, want)
		}
	}
}

// nopWriter is a ResponseWriter that allocates nothing.
type nopWriter struct{ h http.Header }

func (n nopWriter) Header() http.Header       { return n.h }
func (nopWriter) Write(b []byte) (int, error) { return len(b), nil }
func (nopWriter) WriteHeader(int)             {}

// TestTraceRoutingAllocations guards the trace path: deciding that a trace
// request stays with the receiver must not allocate.
func TestTraceRoutingAllocations(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	_, h := newTestHandler(t, srv.URL, time.Second, nil)
	inner := h.(*handler)
	inner.next = http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})
	inner.once.Do(func() { inner.recv = learnReceiver((&fakeReceiver{}).handler()) })

	w := nopWriter{h: http.Header{}}
	reqs := []*http.Request{
		httptest.NewRequest(http.MethodPut, "/v0.4/traces", http.NoBody),
		httptest.NewRequest(http.MethodPut, "/v0.5/traces", http.NoBody),
		httptest.NewRequest(http.MethodPut, "/v1.0/traces", http.NoBody),
	}
	allocs := testing.AllocsPerRun(1000, func() {
		for _, r := range reqs {
			h.ServeHTTP(w, r)
		}
	})
	if allocs != 0 {
		t.Errorf("allocs per run = %v, want 0", allocs)
	}
}

func BenchmarkTraceRouting(b *testing.B) {
	h := &handler{next: http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})}
	h.once.Do(func() { h.recv = learnReceiver((&fakeReceiver{}).handler()) })
	w := nopWriter{h: http.Header{}}
	r := httptest.NewRequest(http.MethodPut, "/v0.4/traces", http.NoBody)
	b.ReportAllocs()
	for b.Loop() {
		h.ServeHTTP(w, r)
	}
}
