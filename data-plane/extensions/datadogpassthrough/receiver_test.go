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

// TestWithDatadogReceiver runs the stock contrib datadog receiver with the
// middleware configured the way users do: `middlewares: [{id: ...}]`.
func TestWithDatadogReceiver(t *testing.T) {
	ctx := context.Background()
	agent := &fakeAgent{}
	agentSrv := httptest.NewServer(agent.handler())
	defer agentSrv.Close()

	ext, err := NewFactory().Create(ctx, extensiontest.NewNopSettings(Type), &Config{Endpoint: agentSrv.URL, Timeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	host := testHost{Host: componenttest.NewNopHost(), extensions: map[component.ID]component.Component{component.NewID(Type): ext}}
	if err := ext.Start(ctx, host); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ext.Shutdown(ctx) }()

	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	_ = l.Close()

	f := datadogreceiver.NewFactory()
	cfg := f.CreateDefaultConfig()
	if err := confmap.NewFromStringMap(map[string]any{
		"endpoint":    addr,
		"middlewares": []any{map[string]any{"id": "chopper_datadog_passthrough"}},
	}).Unmarshal(cfg); err != nil {
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
	defer func() { _ = recv.Shutdown(ctx) }()
	base := "http://" + addr

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

	// A profile reaches the Agent. confighttp decompresses request bodies
	// before middlewares run, so the Agent gets it uncompressed.
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	_, _ = zw.Write([]byte("pprof bytes"))
	_ = zw.Close()
	resp = post(t, base+"/profiling/v1/input", "multipart/form-data; boundary=x", "gzip", gz.Bytes())
	if resp.StatusCode != http.StatusAccepted {
		t.Errorf("profile: %d, want the Agent's 202", resp.StatusCode)
	}

	// Trace intakes the receiver doesn't implement never reach the Agent.
	post(t, base+"/v1.0/traces", "application/msgpack", "", payload)
	post(t, base+"/v0.6/stats", "application/msgpack", "", []byte{0x80})

	agent.mu.Lock()
	got := slices.Clone(agent.requests)
	agent.mu.Unlock()
	if len(got) != 1 || got[0].path != "/profiling/v1/input" || got[0].body != "pprof bytes" {
		t.Errorf("Agent got %+v, want one uncompressed profile", got)
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
