package datadogpassthrough

import (
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/collector/confmap"
)

func TestConfigFromYAMLMap(t *testing.T) {
	cfg := NewFactory().CreateDefaultConfig().(*Config)
	conf := confmap.NewFromStringMap(map[string]any{"endpoint": "http://datadog-agent:8126"})
	if err := conf.Unmarshal(cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.Endpoint != "http://datadog-agent:8126" || cfg.Timeout != 30*time.Second {
		t.Errorf("got %+v", cfg)
	}
	if err := cfg.Validate(); err != nil {
		t.Error(err)
	}
}

func TestConfigValidate(t *testing.T) {
	for _, tc := range []struct {
		endpoint string
		timeout  time.Duration
		err      string
	}{
		{"http://datadog-agent:8126", time.Second, ""},
		{"https://agent.example:443/", time.Second, ""},
		{"unix:///var/run/datadog/apm.socket", time.Second, ""},
		{"", time.Second, "endpoint is required"},
		{"datadog-agent:8126", time.Second, "scheme must be"},
		{"http://", time.Second, "no host"},
		{"unix://", time.Second, "no socket path"},
		{"http://datadog-agent:8126", 0, "timeout must be positive"},
	} {
		err := (&Config{Endpoint: tc.endpoint, Timeout: tc.timeout}).Validate()
		switch {
		case tc.err == "" && err != nil:
			t.Errorf("%q: unexpected error %v", tc.endpoint, err)
		case tc.err != "" && (err == nil || !strings.Contains(err.Error(), tc.err)):
			t.Errorf("%q, %s: error %v, want %q", tc.endpoint, tc.timeout, err, tc.err)
		}
	}
}

func TestParseEndpointUnix(t *testing.T) {
	target, socket, err := parseEndpoint("unix:///var/run/datadog/apm.socket")
	if err != nil || socket != "/var/run/datadog/apm.socket" || target.String() != "http://localhost" {
		t.Errorf("got %v %q %v", target, socket, err)
	}
}
