package datadogpassthrough

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// Config for the chopper_datadog_passthrough extension.
//
//	extensions:
//	  chopper_datadog_passthrough:
//	    endpoint: http://datadog-agent:8126
//	receivers:
//	  datadog:
//	    endpoint: 0.0.0.0:8126
//	    middlewares:
//	      - id: chopper_datadog_passthrough
type Config struct {
	// Endpoint is the trace API of the Datadog Agent that requests the
	// datadog receiver doesn't handle are forwarded to: http://host:8126,
	// https://host:port, or unix:///var/run/datadog/apm.socket.
	Endpoint string `mapstructure:"endpoint"`

	// Timeout bounds each forwarded request, from the start of the upload to
	// the end of the Agent's response. A request that runs over gets a 502.
	Timeout time.Duration `mapstructure:"timeout"`

	// prevent unkeyed literal initialization
	_ struct{}
}

// Validate is called by the collector before the extension is created.
func (c *Config) Validate() error {
	if _, _, err := parseEndpoint(c.Endpoint); err != nil {
		return err
	}
	if c.Timeout <= 0 {
		return fmt.Errorf("timeout must be positive, got %s", c.Timeout)
	}
	return nil
}

// parseEndpoint returns the URL requests are sent to and, for a unix://
// endpoint, the socket path to dial instead of the URL's host.
func parseEndpoint(endpoint string) (target *url.URL, socket string, err error) {
	if endpoint == "" {
		return nil, "", errors.New("endpoint is required: the Datadog Agent's trace API, e.g. http://datadog-agent:8126")
	}
	u, err := url.Parse(endpoint)
	if err != nil {
		return nil, "", fmt.Errorf("endpoint %q: %w", endpoint, err)
	}
	switch u.Scheme {
	case "http", "https":
		if u.Host == "" {
			return nil, "", fmt.Errorf("endpoint %q has no host", endpoint)
		}
		u.Path = strings.TrimSuffix(u.Path, "/")
		return u, "", nil
	case "unix":
		if u.Path == "" {
			return nil, "", fmt.Errorf("endpoint %q has no socket path", endpoint)
		}
		// The host is only used for the Host header; the Agent ignores it.
		return &url.URL{Scheme: "http", Host: "localhost"}, u.Path, nil
	default:
		return nil, "", fmt.Errorf("endpoint %q: scheme must be http, https or unix", endpoint)
	}
}
