package filterprocessor

import (
	"context"
	"testing"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/ptrace"
)

// Issue #45: a SAMPLE rule whose condition only some spans of a trace
// satisfy. Each trace below has two backend spans that carry
// service.namespace and two browser spans that don't, mirroring the
// OpenTelemetry Demo, where frontend-web and image-provider never set it.

func namespaceSampleRule(scope string, rate *float64) PolicyRule {
	return PolicyRule{
		ID:             "r-sample",
		IsActive:       true,
		Name:           "sample-demo",
		ActionType:     ActionSample,
		SampleRate:     rate,
		SampleScope:    scope,
		TargetSignal:   SignalTraces,
		ConditionField: "service.namespace",
		ConditionOp:    OpEquals,
		ConditionValue: "opentelemetry-demo",
	}
}

// mixedNamespaceTraces builds n traces, each split across a backend resource
// (with service.namespace) and a browser resource (without), two spans each.
func mixedNamespaceTraces(n int) (ptrace.Traces, []pcommon.TraceID) {
	td := ptrace.NewTraces()
	ids := make([]pcommon.TraceID, 0, n)
	for b := 0; b < n; b++ {
		id := traceIDFromByte(byte(b * 4))
		ids = append(ids, id)

		backend := td.ResourceSpans().AppendEmpty()
		backend.Resource().Attributes().PutStr("service.name", "frontend")
		backend.Resource().Attributes().PutStr("service.namespace", "opentelemetry-demo")
		spans := backend.ScopeSpans().AppendEmpty().Spans()
		addSpan(spans, id, "GET /api/products")
		addSpan(spans, id, "ProductCatalogService/ListProducts")

		browser := td.ResourceSpans().AppendEmpty()
		browser.Resource().Attributes().PutStr("service.name", "frontend-web")
		spans = browser.ScopeSpans().AppendEmpty().Spans()
		addSpan(spans, id, "documentLoad")
		addSpan(spans, id, "HTTP GET")
	}
	return td, ids
}

func spansPerTrace(td ptrace.Traces) map[pcommon.TraceID]int {
	out := map[pcommon.TraceID]int{}
	rss := td.ResourceSpans()
	for i := 0; i < rss.Len(); i++ {
		sss := rss.At(i).ScopeSpans()
		for j := 0; j < sss.Len(); j++ {
			spans := sss.At(j).Spans()
			for k := 0; k < spans.Len(); k++ {
				out[spans.At(k).TraceID()]++
			}
		}
	}
	return out
}

// The bug, pinned: span scope (and a rule with no scope, from an older
// control plane) leaves the browser spans of every sampled-out trace behind.
func TestSpanScopedSampleSplitsTracesItsConditionMisses(t *testing.T) {
	for _, scope := range []string{"", SampleScopeSpan} {
		rate := 0.25
		p := newTestProcessor(t, []PolicyRule{namespaceSampleRule(scope, &rate)})
		td, ids := mixedNamespaceTraces(64)
		if err := p.ConsumeTraces(context.Background(), td); err != nil {
			t.Fatalf("ConsumeTraces: %v", err)
		}
		got := spansPerTrace(td)
		split := 0
		for _, id := range ids {
			if traceIDBucket(id) >= sampleKeepThreshold(rate) {
				if got[id] != 2 {
					t.Errorf("scope %q: sampled-out trace kept %d spans, want the 2 unmatched browser spans", scope, got[id])
				}
				split++
			}
		}
		if split == 0 {
			t.Fatalf("scope %q: no trace sampled out — test data is degenerate", scope)
		}
	}
}

// The fix: a whole-trace rule keeps or drops every span of a trace, whatever
// its condition says, so no span is left without its parent.
func TestWholeTraceSampleKeepsOrDropsEverySpan(t *testing.T) {
	rate := 0.25
	p := newTestProcessor(t, []PolicyRule{namespaceSampleRule(SampleScopeTrace, &rate)})
	td, ids := mixedNamespaceTraces(64)
	if err := p.ConsumeTraces(context.Background(), td); err != nil {
		t.Fatalf("ConsumeTraces: %v", err)
	}
	got := spansPerTrace(td)
	kept := 0
	for _, id := range ids {
		want := 0
		if traceIDBucket(id) < sampleKeepThreshold(rate) {
			want = 4
			kept++
		}
		if got[id] != want {
			t.Errorf("trace %v: %d spans survived, want %d (trace split)", id, got[id], want)
		}
	}
	if kept == 0 || kept == len(ids) {
		t.Errorf("degenerate sample: %d/%d traces kept", kept, len(ids))
	}
}

// Whole-trace and span-scoped rules hash the same TraceID, so a trace one
// rule keeps is never dropped by the other on another span, and a mixed
// fleet of collectors (some still on span scope) agrees per trace.
func TestWholeTraceSampleAgreesWithSpanScopeOnMatchedSpans(t *testing.T) {
	rate := 0.4
	span := newTestProcessor(t, []PolicyRule{namespaceSampleRule(SampleScopeSpan, &rate)})
	whole := newTestProcessor(t, []PolicyRule{namespaceSampleRule(SampleScopeTrace, &rate)})
	a, ids := mixedNamespaceTraces(32)
	b, _ := mixedNamespaceTraces(32)
	_ = span.ConsumeTraces(context.Background(), a)
	_ = whole.ConsumeTraces(context.Background(), b)
	ga, gb := spansPerTrace(a), spansPerTrace(b)
	for _, id := range ids {
		// Span scope keeps the 2 backend spans of exactly the traces whole
		// scope keeps in full.
		if (ga[id] == 4) != (gb[id] == 4) {
			t.Errorf("trace %v: span scope kept %d spans, whole trace kept %d — verdicts disagree", id, ga[id], gb[id])
		}
	}
}

// Per-rule counts: a span-scoped rule reports every span it evaluated, so the
// dashboard can show the share its condition misses; a whole-trace rule
// matches every span and reports no evaluated count.
func TestSampleScopeRuleCounts(t *testing.T) {
	rate := 0.25
	for _, c := range []struct {
		scope              string
		matched, evaluated int64
	}{
		{SampleScopeSpan, 128, 256},
		{SampleScopeTrace, 256, 0},
	} {
		p := newTestProcessor(t, []PolicyRule{namespaceSampleRule(c.scope, &rate)})
		td, _ := mixedNamespaceTraces(64)
		if err := p.ConsumeTraces(context.Background(), td); err != nil {
			t.Fatalf("ConsumeTraces: %v", err)
		}
		st := p.engine.rules[0].stats
		if m, e := st.matched.Load(), st.evaluated.Load(); m != c.matched || e != c.evaluated {
			t.Errorf("scope %s: matched=%d evaluated=%d, want %d/%d", c.scope, m, e, c.matched, c.evaluated)
		}
		if d := st.dropped.Load(); d == 0 || d >= c.matched {
			t.Errorf("scope %s: dropped=%d, want part of %d", c.scope, d, c.matched)
		}
	}
}

// A scope this collector doesn't know fails open: nothing is dropped.
func TestSampleWithUnknownScopeIsNotEnforced(t *testing.T) {
	rate := 0.0
	p := newTestProcessor(t, []PolicyRule{namespaceSampleRule("SESSION", &rate)})
	td, _ := mixedNamespaceTraces(8)
	if err := p.ConsumeTraces(context.Background(), td); err != nil {
		t.Fatalf("ConsumeTraces: %v", err)
	}
	if n := td.SpanCount(); n != 32 {
		t.Errorf("SpanCount = %d, want all 32 spans kept", n)
	}
}
