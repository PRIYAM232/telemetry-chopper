package filterprocessor

import (
	"context"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// meterScope names the instrumentation scope on the collector's self-telemetry
// meter. Mirrors the module path, the same convention mdatagen uses for the
// upstream components.
const meterScope = "github.com/PRIYAM232/telemetry-chopper/data-plane/processors/filterprocessor"

// engineTelemetry publishes the engine's counters on the collector's OWN
// telemetry pipeline (Prometheus on :8888 by default), alongside the stock
// otelcol_* process and pipeline metrics. This is the pull-based twin of the
// stats heartbeat in engine.go: the heartbeat feeds the Telemetry Chopper dashboard's
// savings numbers through the control plane, these instruments feed the
// operator's Prometheus/Grafana stack directly — self-monitoring must not
// depend on the control plane being reachable.
//
// Naming follows the collector convention (otelcol_ prefix baked into the
// instrument name). The counters are cumulative since process start — unlike
// the heartbeat's interval deltas — because that is what Prometheus rate()
// expects.
type engineTelemetry struct {
	spansReceived   metric.Int64Counter
	spansDropped    metric.Int64Counter
	logsReceived    metric.Int64Counter
	logsDropped     metric.Int64Counter
	metricsReceived metric.Int64Counter
	metricsDropped  metric.Int64Counter
}

// newEngineTelemetry registers the chopper_filter instruments. rulesTotal is
// observed at scrape time (an async gauge), so the rule count is always
// current even though rulesets swap wholesale between scrapes. eachRule
// walks the per-rule counters for the rule_matched / rule_dropped
// observable counters: observed at scrape time from the cumulative atomics,
// so the hot paths never touch an attribute set. Cardinality is bounded by
// the ruleset size.
func newEngineTelemetry(ts component.TelemetrySettings, rulesTotal func() int64, eachRule func(func(*ruleCounters))) (*engineTelemetry, error) {
	// The collector service always injects a MeterProvider; tests building
	// processor.Settings by hand may not. nil provider → self-metrics off,
	// mirroring the nil-telemetry tolerance in the engine's observe helpers.
	if ts.MeterProvider == nil {
		return nil, nil
	}
	meter := ts.MeterProvider.Meter(meterScope)

	var errs []error
	counter := func(name, desc, unit string) metric.Int64Counter {
		c, err := meter.Int64Counter(name,
			metric.WithDescription(desc),
			metric.WithUnit(unit),
		)
		if err != nil {
			errs = append(errs, err)
		}
		return c
	}

	t := &engineTelemetry{
		spansReceived:   counter("otelcol_chopper_filter_spans_received", "Spans entering the chopper_filter processor.", "{spans}"),
		spansDropped:    counter("otelcol_chopper_filter_spans_dropped", "Spans removed by chopper_filter rules (DROP, SAMPLE, THROTTLE).", "{spans}"),
		logsReceived:    counter("otelcol_chopper_filter_logs_received", "Log records entering the chopper_filter processor.", "{records}"),
		logsDropped:     counter("otelcol_chopper_filter_logs_dropped", "Log records removed by chopper_filter rules.", "{records}"),
		metricsReceived: counter("otelcol_chopper_filter_metrics_received", "Metrics entering the chopper_filter processor.", "{metrics}"),
		metricsDropped:  counter("otelcol_chopper_filter_metrics_dropped", "Metrics removed by chopper_filter rules.", "{metrics}"),
	}

	_, err := meter.Int64ObservableGauge("otelcol_chopper_filter_rules",
		metric.WithDescription("Rules in the currently synced chopper_filter ruleset (0 until the first successful policy sync)."),
		metric.WithUnit("{rules}"),
		metric.WithInt64Callback(func(_ context.Context, o metric.Int64Observer) error {
			o.Observe(rulesTotal())
			return nil
		}),
	)
	if err != nil {
		errs = append(errs, err)
	}

	ruleMatched, err := meter.Int64ObservableCounter("otelcol_chopper_filter_rule_matched",
		metric.WithDescription("Records whose condition a chopper_filter rule matched, per rule. A record dropped by an earlier rule is not evaluated by later ones."),
		metric.WithUnit("{records}"),
	)
	if err != nil {
		errs = append(errs, err)
	}
	ruleDropped, err := meter.Int64ObservableCounter("otelcol_chopper_filter_rule_dropped",
		metric.WithDescription("Records removed by a chopper_filter rule (DROP, unsampled SAMPLE, THROTTLE excess), per rule."),
		metric.WithUnit("{records}"),
	)
	if err != nil {
		errs = append(errs, err)
	}
	if ruleMatched != nil && ruleDropped != nil {
		_, err = meter.RegisterCallback(func(_ context.Context, o metric.Observer) error {
			eachRule(func(c *ruleCounters) {
				attrs := metric.WithAttributes(
					attribute.String("rule_id", c.id),
					attribute.String("rule_name", c.name),
					attribute.String("signal", c.signal),
					attribute.String("action", c.action),
				)
				o.ObserveInt64(ruleMatched, c.totalMatched.Load(), attrs)
				o.ObserveInt64(ruleDropped, c.totalDropped.Load(), attrs)
			})
			return nil
		}, ruleMatched, ruleDropped)
		if err != nil {
			errs = append(errs, err)
		}
	}

	if len(errs) > 0 {
		return nil, errs[0]
	}
	return t, nil
}
