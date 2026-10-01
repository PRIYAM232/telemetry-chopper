package filterprocessor

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.uber.org/zap"
)

func ruleWithID(id string, r PolicyRule) PolicyRule {
	r.ID = id
	return r
}

func spanDropRule(name, field, value string) PolicyRule {
	return PolicyRule{
		IsActive:       true,
		Name:           name,
		ActionType:     ActionDrop,
		TargetSignal:   SignalTraces,
		ConditionField: field,
		ConditionOp:    OpEquals,
		ConditionValue: value,
	}
}

// Each rule is credited with exactly the records it matched, dropped and
// opted out of indexing; a rule whose condition field matches nothing (the
// typo case from issue #14) reports zero; per-rule sums equal the fleet
// totals.
func TestPerRuleCountsTraces(t *testing.T) {
	p := newTestProcessor(t, []PolicyRule{
		ruleWithID("r-unindex", excludeIndexRule("unindex-dev", SignalTraces, "env", "dev")),
		ruleWithID("r-drop", spanDropRule("drop-debug", "tier", "debug")),
		ruleWithID("r-typo", spanDropRule("typo", "tierr", "debug")),
	})

	td := ptrace.NewTraces()
	ss := td.ResourceSpans().AppendEmpty().ScopeSpans().AppendEmpty().Spans()
	add := func(env, tier string) {
		s := ss.AppendEmpty()
		s.SetName("op")
		if env != "" {
			s.Attributes().PutStr("env", env)
		}
		if tier != "" {
			s.Attributes().PutStr("tier", tier)
		}
	}
	add("dev", "")      // unindexed
	add("dev", "")      // unindexed
	add("dev", "debug") // stamped by r-unindex, then dropped by r-drop
	add("", "debug")    // dropped
	add("", "debug")    // dropped
	add("", "")         // untouched

	if err := p.ConsumeTraces(context.Background(), td); err != nil {
		t.Fatal(err)
	}

	rules := p.engine.snapshotRules()
	un, drop, typo := rules[0].stats, rules[1].stats, rules[2].stats

	if got := un.matched.Load(); got != 3 {
		t.Errorf("r-unindex matched = %d, want 3", got)
	}
	if got := un.unindexed.Load(); got != 2 {
		t.Errorf("r-unindex unindexed = %d, want 2 (the third was dropped later)", got)
	}
	if got := un.dropped.Load(); got != 0 {
		t.Errorf("r-unindex dropped = %d, want 0", got)
	}
	if got := drop.matched.Load(); got != 3 {
		t.Errorf("r-drop matched = %d, want 3", got)
	}
	if got := drop.dropped.Load(); got != 3 {
		t.Errorf("r-drop dropped = %d, want 3", got)
	}
	if got, want := drop.droppedBytes.Load(), p.engine.tracesDroppedBytes.Load(); got != want || got == 0 {
		t.Errorf("r-drop droppedBytes = %d, want the fleet total %d (non-zero)", got, want)
	}
	if got := un.unindexed.Load(); got != p.engine.tracesUnindexed.Load() {
		t.Errorf("per-rule unindexed %d != fleet unindexed %d", got, p.engine.tracesUnindexed.Load())
	}
	if m, d := typo.matched.Load(), typo.dropped.Load(); m != 0 || d != 0 {
		t.Errorf("r-typo matched/dropped = %d/%d, want 0/0", m, d)
	}
}

// Rules are evaluated in order and a drop ends evaluation, so a record two
// DROP rules would both match is credited to the first only.
func TestPerRuleFirstDropWins(t *testing.T) {
	p := newTestProcessor(t, []PolicyRule{
		ruleWithID("first", spanDropRule("first", "test.marker", "yes")),
		ruleWithID("second", spanDropRule("second", "test.marker", "yes")),
	})
	td := ptrace.NewTraces()
	ss := td.ResourceSpans().AppendEmpty().ScopeSpans().AppendEmpty().Spans()
	for i := 0; i < 4; i++ {
		addSpan(ss, traceIDFromByte(byte(i)), "op")
	}
	if err := p.ConsumeTraces(context.Background(), td); err != nil {
		t.Fatal(err)
	}
	rules := p.engine.snapshotRules()
	if d := rules[0].stats.dropped.Load(); d != 4 {
		t.Errorf("first dropped = %d, want 4", d)
	}
	if m := rules[1].stats.matched.Load(); m != 0 {
		t.Errorf("second matched = %d, want 0 (records already dropped)", m)
	}
}

// A THROTTLE rule reports every record it saw as matched and only the excess
// as dropped: matched > dropped > 0 is what "actively clamping" looks like.
func TestPerRuleThrottleMatchedVersusDropped(t *testing.T) {
	p := newTestProcessor(t, []PolicyRule{
		ruleWithID("thr", throttleRuleFor("clamp", SignalTraces, 5, "", "test.marker", OpEquals, "yes")),
	})
	td := ptrace.NewTraces()
	ss := td.ResourceSpans().AppendEmpty().ScopeSpans().AppendEmpty().Spans()
	for i := 0; i < 50; i++ {
		addSpan(ss, traceIDFromByte(byte(i)), "op")
	}
	if err := p.ConsumeTraces(context.Background(), td); err != nil {
		t.Fatal(err)
	}
	c := p.engine.snapshotRules()[0].stats
	m, d := c.matched.Load(), c.dropped.Load()
	if m != 50 {
		t.Errorf("throttle matched = %d, want 50", m)
	}
	if d <= 0 || d >= m || d != p.engine.tracesDropped.Load() {
		t.Errorf("throttle dropped = %d, want 0 < dropped < 50 and equal to fleet dropped %d", d, p.engine.tracesDropped.Load())
	}
}

func TestPerRuleCountsLogsAndMetrics(t *testing.T) {
	lp := newTestLogsProcessor(t, []PolicyRule{
		ruleWithID("l-drop", dropLogsRule("drop-debug", fieldLogSeverity, OpEquals, "DEBUG")),
	})
	ld := plog.NewLogs()
	slr := ld.ResourceLogs().AppendEmpty().ScopeLogs().AppendEmpty().LogRecords()
	addLogRecord(slr, "DEBUG", "noisy")
	addLogRecord(slr, "DEBUG", "noisier")
	addLogRecord(slr, "ERROR", "keep")
	if err := lp.ConsumeLogs(context.Background(), ld); err != nil {
		t.Fatal(err)
	}
	lc := lp.engine.snapshotRules()[0].stats
	if lc.matched.Load() != 2 || lc.dropped.Load() != 2 || lc.droppedBytes.Load() != lp.engine.logsDroppedBytes.Load() {
		t.Errorf("logs rule matched/dropped/bytes = %d/%d/%d, want 2/2/%d",
			lc.matched.Load(), lc.dropped.Load(), lc.droppedBytes.Load(), lp.engine.logsDroppedBytes.Load())
	}

	mp := newTestMetricsProcessor(t, []PolicyRule{
		ruleWithID("m-drop", dropMetricsRule("drop-gc", fieldMetricName, OpContains, "gc")),
	})
	md := pmetric.NewMetrics()
	ms := md.ResourceMetrics().AppendEmpty().ScopeMetrics().AppendEmpty().Metrics()
	addGauge(ms, "runtime.gc.count")
	addGauge(ms, "http.server.duration")
	if err := mp.ConsumeMetrics(context.Background(), md); err != nil {
		t.Fatal(err)
	}
	mc := mp.engine.snapshotRules()[0].stats
	if mc.matched.Load() != 1 || mc.dropped.Load() != 1 || mc.droppedBytes.Load() != mp.engine.metricsDroppedBytes.Load() {
		t.Errorf("metrics rule matched/dropped/bytes = %d/%d/%d, want 1/1/%d",
			mc.matched.Load(), mc.dropped.Load(), mc.droppedBytes.Load(), mp.engine.metricsDroppedBytes.Load())
	}
}

// The heartbeat carries per-rule counts for active rules only; counters
// survive a ruleset swap by rule ID; a failed POST carries them over; a
// rule removed mid-interval is reported one final time, then forgotten.
func TestReportStatsOnceSendsPerRuleCounts(t *testing.T) {
	status := http.StatusNoContent
	var got []statsPayload
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body statsPayload
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode stats body: %v", err)
		}
		got = append(got, body)
		w.WriteHeader(status)
	}))
	defer srv.Close()

	e := newRuleEngine(zap.NewNop(), &Config{StatsEndpoint: srv.URL, FleetKey: "test-key"})
	publish := func(rules ...PolicyRule) {
		compiled := compileRules(rules, zap.NewNop())
		e.ruleStats.adopt(compiled)
		e.rules = compiled
	}
	keep := ruleWithID("keep", spanDropRule("keep", "a", "1"))
	gone := ruleWithID("gone", spanDropRule("gone", "b", "1"))
	idle := ruleWithID("idle", spanDropRule("idle", "c", "1"))

	publish(keep, gone, idle)
	first := e.snapshotRules()
	first[0].stats.countMatch()
	first[0].stats.countDrop(100)
	first[1].stats.countMatch()
	first[1].stats.countDrop(40)

	// Resync without "gone": "keep" must reuse the same counters.
	publish(keep, idle)
	if e.snapshotRules()[0].stats != first[0].stats {
		t.Fatal("counters for an unchanged rule ID were replaced on resync")
	}
	e.snapshotRules()[0].stats.countDrop(10)

	ctx := context.Background()
	status = http.StatusInternalServerError
	e.reportStatsOnce(ctx)
	if d := first[0].stats.dropped.Load(); d != 2 {
		t.Errorf("keep dropped after failed report = %d, want 2 carried over", d)
	}

	status = http.StatusNoContent
	e.reportStatsOnce(ctx)
	byID := map[string]ruleStatsPayload{}
	for _, r := range got[1].Rules {
		byID[r.RuleID] = r
	}
	if r := byID["keep"]; r.Matched != 1 || r.Dropped != 2 || r.DroppedBytes != 110 {
		t.Errorf("keep = %+v, want matched 1, dropped 2, bytes 110", r)
	}
	if r := byID["gone"]; r.Matched != 1 || r.Dropped != 1 || r.DroppedBytes != 40 {
		t.Errorf("gone = %+v, want its final counts 1/1/40", r)
	}
	if _, ok := byID["idle"]; ok {
		t.Error("idle rule with no activity was sent")
	}

	e.reportStatsOnce(ctx)
	if n := len(got[2].Rules); n != 0 {
		t.Errorf("rules in an idle interval = %d, want 0", n)
	}
	if e.ruleStats.retired != nil {
		t.Error("retired counters were kept after their final report")
	}
	seen := 0
	e.ruleStats.each(func(*ruleCounters) { seen++ })
	if seen != 2 {
		t.Errorf("self-metrics walk %d rules, want the 2 current ones", seen)
	}
}
