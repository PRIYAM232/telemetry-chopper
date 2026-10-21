// Package datadogpassthrough implements the chopper_datadog_passthrough
// extension: an HTTP middleware for the contrib datadog receiver that sends
// every request the receiver doesn't handle to a real Datadog Agent.
//
// The datadog receiver accepts traces from Datadog tracing libraries on the
// Agent's port (8126) and answers every other path with 200 and discards the
// body. Tracers use that port for much more than traces: Continuous Profiler
// uploads, Data Streams Monitoring, Dynamic Instrumentation, remote
// configuration, instrumentation telemetry and the EVP proxy. With this
// middleware those requests reach the Agent unchanged, and the receiver's
// /info answer advertises them, so tracers keep those features on.
//
// Trace and APM stats intakes are never forwarded: traces must run through
// the rules, and forwarding them, or client-computed stats, would let a tracer
// bypass the collector. They stay with the receiver.
package datadogpassthrough

import (
	"context"
	"fmt"
	"time"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/extension"
)

// Type is the component type users reference in the collector YAML.
var Type = component.MustNewType("chopper_datadog_passthrough")

// NewFactory registers the extension with the collector.
func NewFactory() extension.Factory {
	return extension.NewFactory(Type, createDefaultConfig, create, component.StabilityLevelDevelopment)
}

func createDefaultConfig() component.Config {
	return &Config{Timeout: 30 * time.Second}
}

func create(_ context.Context, set extension.Settings, cfg component.Config) (extension.Extension, error) {
	c, ok := cfg.(*Config)
	if !ok {
		return nil, fmt.Errorf("invalid configuration type: expected *datadogpassthrough.Config, got %T", cfg)
	}
	return newPassthrough(set, c)
}
