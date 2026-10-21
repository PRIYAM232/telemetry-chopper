package datadogpassthrough

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"
)

const (
	// infoTTL is how long the Agent's /info answer is reused. Tracers ask
	// for /info at startup and now and then, not per request.
	infoTTL = 30 * time.Second
	// infoRetry is how long a failed /info fetch is remembered, so tracers
	// starting while the Agent is down don't each wait for a timeout.
	infoRetry = 5 * time.Second
	// infoTimeout bounds the fetch a tracer's /info request may wait for.
	infoTimeout = 2 * time.Second
	// maxInfoBytes caps the Agent's /info body (about 3 KB on Agent 7.84).
	maxInfoBytes = 1 << 20
)

// copiedInfoFields are the Agent /info fields that describe forwarded
// features, so they're passed on to tracers. Fields that change how tracers
// send traces (client_drop_p0s, span_events, peer_tags and the rest) keep the
// receiver's answer: traces go to the receiver, not the Agent.
var copiedInfoFields = []string{"config", "evp_proxy_allowed_headers"}

// receiverRoutes is what the wrapped datadog receiver handles itself, learned
// from its own /info answer, which lists every path it registered.
type receiverRoutes struct {
	info     map[string]json.RawMessage // its /info, nil if unreadable
	paths    []string                   // advertised paths, without "/"
	exact    map[string]struct{}
	prefixes []string // subtree patterns ending in "/", e.g. /intake/
}

// fallbackRoutes are the trace intakes of the v0.156.0 receiver, used if its
// /info can't be read. isTraceIntake covers them as well.
var fallbackRoutes = []string{"/v0.3/traces", "/v0.4/traces", "/v0.5/traces", "/v0.7/traces", "/api/v0.2/traces"}

func learnReceiver(next http.Handler) receiverRoutes {
	rec := &bufferWriter{header: http.Header{}}
	req, _ := http.NewRequest(http.MethodGet, "/info", http.NoBody)
	next.ServeHTTP(rec, req)

	var routes receiverRoutes
	var parsed struct {
		Endpoints []string `json:"endpoints"`
	}
	if rec.status() == http.StatusOK &&
		json.Unmarshal(rec.body.Bytes(), &routes.info) == nil &&
		json.Unmarshal(rec.body.Bytes(), &parsed) == nil && len(parsed.Endpoints) > 0 {
		routes.paths = parsed.Endpoints
	} else {
		routes.info = nil
		routes.paths = fallbackRoutes
	}
	routes.exact = make(map[string]struct{}, len(routes.paths))
	kept := routes.paths[:0:0]
	for _, p := range routes.paths {
		switch {
		case p == "/": // the receiver's catch-all, which is what we replace
			continue
		case strings.HasSuffix(p, "/"):
			routes.prefixes = append(routes.prefixes, p)
		default:
			routes.exact[p] = struct{}{}
		}
		kept = append(kept, p)
	}
	routes.paths = kept
	return routes
}

func (r *receiverRoutes) handles(path string) bool {
	if _, ok := r.exact[path]; ok {
		return true
	}
	for _, p := range r.prefixes {
		if strings.HasPrefix(path, p) {
			return true
		}
	}
	return false
}

// serveInfo answers /info with the receiver's answer plus the Agent's
// forwardable endpoints, so tracers turn on the features that now work. If
// the Agent can't be reached, the receiver answers alone, as without this
// extension.
func (h *handler) serveInfo(w http.ResponseWriter, r *http.Request) {
	agent := h.p.info.get(r.Context(), h.p)
	if agent == nil || h.recv.info == nil {
		h.next.ServeHTTP(w, r)
		return
	}
	body, err := mergeInfo(h.recv, agent)
	if err != nil {
		h.next.ServeHTTP(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}

func mergeInfo(recv receiverRoutes, agent map[string]json.RawMessage) ([]byte, error) {
	var agentEndpoints []string
	if raw, ok := agent["endpoints"]; ok {
		_ = json.Unmarshal(raw, &agentEndpoints)
	}
	endpoints := slices.Clone(recv.paths)
	for _, e := range agentEndpoints {
		if e == "/" || e == "/info" || isTraceIntake(e) || recv.handles(e) || slices.Contains(endpoints, e) {
			continue
		}
		endpoints = append(endpoints, e)
	}
	merged := make(map[string]json.RawMessage, len(recv.info)+len(copiedInfoFields))
	for k, v := range recv.info {
		merged[k] = v
	}
	raw, err := json.Marshal(endpoints)
	if err != nil {
		return nil, err
	}
	merged["endpoints"] = raw
	for _, k := range copiedInfoFields {
		if v, ok := agent[k]; ok {
			merged[k] = v
		}
	}
	return json.MarshalIndent(merged, "", "\t")
}

// agentInfoCache holds the Agent's last /info answer.
type agentInfoCache struct {
	mu      sync.Mutex
	expires time.Time
	info    map[string]json.RawMessage // nil after a failed fetch
}

func (c *agentInfoCache) get(ctx context.Context, p *passthrough) map[string]json.RawMessage {
	c.mu.Lock()
	defer c.mu.Unlock()
	if time.Now().Before(c.expires) {
		return c.info
	}
	info, err := p.fetchInfo(ctx)
	if err != nil {
		p.logger.Debug("Datadog Agent /info unavailable; answering with the receiver's endpoints only",
			zap.String("agent", p.cfg.Endpoint), zap.Error(err))
		c.info, c.expires = nil, time.Now().Add(infoRetry)
		return nil
	}
	c.info, c.expires = info, time.Now().Add(infoTTL)
	return info
}

func (p *passthrough) fetchInfo(ctx context.Context) (map[string]json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), infoTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.target.JoinPath("/info").String(), http.NoBody)
	if err != nil {
		return nil, err
	}
	resp, err := p.transport.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxInfoBytes))
		return nil, &statusError{code: resp.StatusCode}
	}
	var info map[string]json.RawMessage
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxInfoBytes)).Decode(&info); err != nil {
		return nil, err
	}
	return info, nil
}

type statusError struct{ code int }

func (e *statusError) Error() string { return "Agent /info answered " + http.StatusText(e.code) }

// bufferWriter captures the receiver's own /info answer.
type bufferWriter struct {
	header http.Header
	code   int
	body   bytes.Buffer
}

func (b *bufferWriter) Header() http.Header         { return b.header }
func (b *bufferWriter) Write(p []byte) (int, error) { return b.body.Write(p) }
func (b *bufferWriter) WriteHeader(code int) {
	if b.code == 0 {
		b.code = code
	}
}

func (b *bufferWriter) status() int {
	if b.code == 0 {
		return http.StatusOK
	}
	return b.code
}
