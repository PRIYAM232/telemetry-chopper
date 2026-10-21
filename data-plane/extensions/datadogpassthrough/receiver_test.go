package datadogpassthrough

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	pb "github.com/DataDog/datadog-agent/pkg/proto/pbgo/trace"
	"github.com/open-telemetry/opentelemetry-collector-contrib/receiver/datadogreceiver"
	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/component/componenttest"
	"go.opentelemetry.io/collector/confmap"
	"go.opentelemetry.io/collector/consumer/consumertest"
	"go.opentelemetry.io/collector/extension/extensiontest"
	"go.opentelemetry.io/collector/receiver/receivertest"
)

// testHost exposes the extension to the receiver, as the collector does.
type testHost struct {
	component.Host
	extensions map[component.ID]component.Component
}

func (h testHost) GetExtensions() map[component.ID]component.Component { return h.extensions }

// startReceiver runs the stock contrib datadog receiver with the middleware
// configured the way users do: `middlewares: [{id: ...}]`, plus extra
// receiver settings. It returns the receiver's base URL.
func startReceiver(t *testing.T, agent *fakeAgent, extra map[string]any) (string, *consumertest.TracesSink) {
	t.Helper()
	ctx := context.Background()
	agentSrv := httptest.NewServer(agent.handler())
	t.Cleanup(agentSrv.Close)

	ext, err := NewFactory().Create(ctx, extensiontest.NewNopSettings(Type), &Config{Endpoint: agentSrv.URL, Timeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	host := testHost{Host: componenttest.NewNopHost(), extensions: map[component.ID]component.Component{component.NewID(Type): ext}}
	if err := ext.Start(ctx, host); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ext.Shutdown(ctx) })

	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	_ = l.Close()

	f := datadogreceiver.NewFactory()
	cfg := f.CreateDefaultConfig()
	settings := map[string]any{
		"endpoint":    addr,
		"middlewares": []any{map[string]any{"id": "chopper_datadog_passthrough"}},
	}
	for k, v := range extra {
		settings[k] = v
	}
	if err := confmap.NewFromStringMap(settings).Unmarshal(cfg); err != nil {
		t.Fatal(err)
	}
	sink := new(consumertest.TracesSink)
	recv, err := f.CreateTraces(ctx, receivertest.NewNopSettings(f.Type()), cfg, sink)
	if err != nil {
		t.Fatal(err)
	}
	if err := recv.Start(ctx, host); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = recv.Shutdown(ctx) })
	return "http://" + addr, sink
}

// gzipped compresses s.
func gzipped(t *testing.T, s string) []byte {
	t.Helper()
	var b bytes.Buffer
	zw := gzip.NewWriter(&b)
	_, _ = zw.Write([]byte(s))
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// gunzipped decompresses b, failing the test if it isn't gzip.
func gunzipped(t *testing.T, b string) string {
	t.Helper()
	zr, err := gzip.NewReader(strings.NewReader(b))
	if err != nil {
		t.Fatalf("not gzip: %v", err)
	}
	out, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

// TestWithDatadogReceiver runs the stock receiver with its default settings.
func TestWithDatadogReceiver(t *testing.T) {
	agent := &fakeAgent{}
	base, sink := startReceiver(t, agent, nil)

	// Traces still go through the receiver into the pipeline.
	payload, err := pb.Traces{pb.Trace{&pb.Span{
		Service: "checkout", Name: "flask.request", Resource: "GET /checkout",
		TraceID: 1, SpanID: 2, Start: time.Now().UnixNano(), Duration: 1000,
	}}}.MarshalMsg(nil)
	if err != nil {
		t.Fatal(err)
	}
	resp := post(t, base+"/v0.4/traces", "application/msgpack", "", payload)
	if resp.StatusCode != http.StatusOK || sink.SpanCount() != 1 {
		t.Fatalf("traces: %d, %d spans in the pipeline", resp.StatusCode, sink.SpanCount())
	}

	// A gzipped Data Streams payload reaches the Agent gzipped. confighttp
	// decompresses it before middlewares run, so the middleware compresses
	// it again: Datadog's intake rejects uncompressed DSM payloads.
	resp = post(t, base+"/v0.1/pipeline_stats", "application/msgpack", "gzip", gzipped(t, "dsm bytes"))
	if resp.StatusCode != http.StatusAccepted {
		t.Errorf("DSM payload: %d, want the Agent's 202", resp.StatusCode)
	}
	// An uncompressed profile is forwarded as is.
	resp = post(t, base+"/profiling/v1/input", "multipart/form-data; boundary=x", "", []byte("pprof bytes"))
	if resp.StatusCode != http.StatusAccepted {
		t.Errorf("profile: %d, want the Agent's 202", resp.StatusCode)
	}

	// Trace intakes the receiver doesn't implement never reach the Agent.
	post(t, base+"/v1.0/traces", "application/msgpack", "", payload)
	post(t, base+"/v0.6/stats", "application/msgpack", "", []byte{0x80})

	agent.mu.Lock()
	got := slices.Clone(agent.requests)
	agent.mu.Unlock()
	if len(got) != 2 {
		t.Fatalf("Agent got %d requests, want 2: %+v", len(got), got)
	}
	if got[0].path != "/v0.1/pipeline_stats" || got[0].header.Get("Content-Encoding") != "gzip" || gunzipped(t, got[0].body) != "dsm bytes" {
		t.Errorf("DSM payload arrived as %+v, want gzip of the original", got[0])
	}
	if got[1].path != "/profiling/v1/input" || got[1].header.Get("Content-Encoding") != "" || got[1].body != "pprof bytes" {
		t.Errorf("profile arrived as %+v, want it unchanged", got[1])
	}
	if sink.SpanCount() != 1 {
		t.Errorf("%d spans in the pipeline, want 1", sink.SpanCount())
	}

	// /info: the receiver's trace endpoints plus the Agent's other features.
	res, err := http.Get(base + "/info")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var info struct {
		Version       string   `json:"version"`
		Endpoints     []string `json:"endpoints"`
		ClientDropP0s bool     `json:"client_drop_p0s"`
	}
	if err := json.NewDecoder(res.Body).Decode(&info); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"/v0.4/traces", "/v0.7/traces", "/profiling/v1/input", "/v0.7/config", "/v0.1/pipeline_stats"} {
		if !slices.Contains(info.Endpoints, want) {
			t.Errorf("/info endpoints %v lack %s", info.Endpoints, want)
		}
	}
	for _, never := range []string{"/", "/v1.0/traces", "/v0.6/stats"} {
		if slices.Contains(info.Endpoints, never) {
			t.Errorf("/info endpoints %v advertise %s", info.Endpoints, never)
		}
	}
	if info.ClientDropP0s {
		t.Error("/info tells tracers to drop P0 traces client-side")
	}
}

func post(t *testing.T, url, contentType, encoding string, body []byte) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("X-Datadog-Trace-Count", "1")
	if encoding != "" {
		req.Header.Set("Content-Encoding", encoding)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	return resp
}

// TestReceiverWithoutDecompression is the recommended setup:
// `compression_algorithms: []` on the receiver, so forwarded requests keep
// their original bytes and Content-Encoding, and traces (which tracers never
// compress) still reach the pipeline.
func TestReceiverWithoutDecompression(t *testing.T) {
	agent := &fakeAgent{}
	base, sink := startReceiver(t, agent, map[string]any{"compression_algorithms": []any{}})

	payload, err := pb.Traces{pb.Trace{&pb.Span{
		Service: "checkout", Name: "flask.request", Resource: "GET /checkout",
		TraceID: 1, SpanID: 2, Start: time.Now().UnixNano(), Duration: 1000,
	}}}.MarshalMsg(nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp := post(t, base+"/v0.4/traces", "application/msgpack", "", payload); resp.StatusCode != http.StatusOK || sink.SpanCount() != 1 {
		t.Fatalf("traces: %d, %d spans in the pipeline", resp.StatusCode, sink.SpanCount())
	}

	original := gzipped(t, "dsm bytes")
	for _, enc := range []string{"gzip", "zstd"} { // zstd: any encoding passes through untouched
		if resp := post(t, base+"/v0.1/pipeline_stats", "application/msgpack", enc, original); resp.StatusCode != http.StatusAccepted {
			t.Errorf("%s DSM payload: %d, want the Agent's 202", enc, resp.StatusCode)
		}
	}
	agent.mu.Lock()
	defer agent.mu.Unlock()
	if len(agent.requests) != 2 {
		t.Fatalf("Agent got %d requests, want 2", len(agent.requests))
	}
	for i, enc := range []string{"gzip", "zstd"} {
		r := agent.requests[i]
		if r.header.Get("Content-Encoding") != enc || r.body != string(original) || r.header.Get("Content-Length") != strconv.Itoa(len(original)) {
			t.Errorf("%s payload arrived with Content-Encoding %q, Content-Length %q, body changed: %v",
				enc, r.header.Get("Content-Encoding"), r.header.Get("Content-Length"), r.body != string(original))
		}
	}
}
