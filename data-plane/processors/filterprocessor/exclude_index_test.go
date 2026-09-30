package filterprocessor

import (
	"context"
	"testing"

	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/ptrace"
)

func excludeIndexRule(name, signal, field, value string) PolicyRule {
	return PolicyRule{
		IsActive:       true,
		Name:           name,
		ActionType:     ActionExcludeIndex,
		TargetSignal:   signal,
		ConditionField: field,
		ConditionOp:    OpEquals,
		ConditionValue: value,
	}
}

// EXCLUDE_INDEX forwards the matched span stamped chopper.index = false,
// leaves its neighbours untouched, and counts it as unindexed, not dropped.
func TestExcludeIndexStampsAndForwardsSpan(t *testing.T) {
	p := newTestProcessor(t, []PolicyRule{
		excludeIndexRule("unindex-health", SignalTraces, "http.route", "/healthz"),
	})

	td := ptrace.NewTraces()
	ss := td.ResourceSpans().AppendEmpty().ScopeSpans().AppendEmpty().Spans()
	health := ss.AppendEmpty()
	health.SetName("GET /healthz")
	health.Attributes().PutStr("http.route", "/healthz")
	other := ss.AppendEmpty()
	other.SetName("GET /items")
	other.Attributes().PutStr("http.route", "/items")

	if err := p.ConsumeTraces(context.Background(), td); err != nil {
		t.Fatalf("ConsumeTraces: %v", err)
	}

	if n := td.SpanCount(); n != 2 {
		t.Fatalf("SpanCount = %d, want 2 (EXCLUDE_INDEX never drops)", n)
	}
	got := td.ResourceSpans().At(0).ScopeSpans().At(0).Spans()
	if v, ok := got.At(0).Attributes().Get(attrIndexExclude); !ok || v.Bool() {
		t.Errorf("matched span %s = %v (present %v), want false", attrIndexExclude, v.AsRaw(), ok)
	}
	if _, ok := got.At(1).Attributes().Get(attrIndexExclude); ok {
		t.Errorf("unmatched span carries %s, want no attribute", attrIndexExclude)
	}
	if u := p.engine.tracesUnindexed.Load(); u != 1 {
		t.Errorf("tracesUnindexed = %d, want 1", u)
	}
	if d := p.engine.tracesDropped.Load(); d != 0 {
		t.Errorf("tracesDropped = %d, want 0", d)
	}
}

// A later DROP still wins: the span is removed and counted as dropped (which
// saves ingest AND indexing), never also as unindexed.
func TestExcludeIndexDoesNotShieldFromDrop(t *testing.T) {
	p := newTestProcessor(t, []PolicyRule{
		excludeIndexRule("unindex-marked", SignalTraces, "test.marker", "yes"),
		{
			IsActive:       true,
			Name:           "drop-marked",
			ActionType:     ActionDrop,
			TargetSignal:   SignalTraces,
			ConditionField: "test.marker",
			ConditionOp:    OpExists,
		},
	})

	td := ptrace.NewTraces()
	ss := td.ResourceSpans().AppendEmpty().ScopeSpans().AppendEmpty().Spans()
	addSpan(ss, traceIDFromByte(1), "doomed")

	if err := p.ConsumeTraces(context.Background(), td); err != nil {
		t.Fatalf("ConsumeTraces: %v", err)
	}
	if d := p.engine.tracesDropped.Load(); d != 1 {
		t.Errorf("tracesDropped = %d, want 1", d)
	}
	if u := p.engine.tracesUnindexed.Load(); u != 0 {
		t.Errorf("tracesUnindexed = %d, want 0 for a dropped span", u)
	}
}

func TestExcludeIndexStampsLogRecord(t *testing.T) {
	p := newTestLogsProcessor(t, []PolicyRule{
		excludeIndexRule("unindex-debug", SignalLogs, fieldLogSeverity, "DEBUG"),
	})

	ld := plog.NewLogs()
	slr := ld.ResourceLogs().AppendEmpty().ScopeLogs().AppendEmpty().LogRecords()
	addLogRecord(slr, "DEBUG", "cache miss")
	addLogRecord(slr, "DEBUG", "retrying")
	addLogRecord(slr, "INFO", "user logged in")

	if err := p.ConsumeLogs(context.Background(), ld); err != nil {
		t.Fatalf("ConsumeLogs: %v", err)
	}
	if n := ld.LogRecordCount(); n != 3 {
		t.Fatalf("LogRecordCount = %d, want 3", n)
	}
	recs := ld.ResourceLogs().At(0).ScopeLogs().At(0).LogRecords()
	for i := 0; i < recs.Len(); i++ {
		v, ok := recs.At(i).Attributes().Get(attrIndexExclude)
		want := recs.At(i).SeverityText() == "DEBUG"
		if ok != want || (ok && v.Bool()) {
			t.Errorf("record %d (%s): %s present=%v value=%v", i, recs.At(i).SeverityText(), attrIndexExclude, ok, v.AsRaw())
		}
	}
	if u := p.engine.logsUnindexed.Load(); u != 2 {
		t.Errorf("logsUnindexed = %d, want 2", u)
	}
}

// Metrics are not indexed events: a METRICS EXCLUDE_INDEX rule is synced but
// not enforced, so the metric passes through unstamped.
func TestExcludeIndexNotEnforcedForMetrics(t *testing.T) {
	p := newTestMetricsProcessor(t, []PolicyRule{
		excludeIndexRule("unindex-metric", SignalMetrics, fieldMetricName, "http.server.duration"),
	})

	md := pmetric.NewMetrics()
	ms := md.ResourceMetrics().AppendEmpty().ScopeMetrics().AppendEmpty().Metrics()
	addGauge(ms, "http.server.duration")

	if err := p.ConsumeMetrics(context.Background(), md); err != nil {
		t.Fatalf("ConsumeMetrics: %v", err)
	}
	if n := md.MetricCount(); n != 1 {
		t.Fatalf("MetricCount = %d, want 1", n)
	}
	if d := p.engine.metricsDropped.Load(); d != 0 {
		t.Errorf("metricsDropped = %d, want 0", d)
	}
}
