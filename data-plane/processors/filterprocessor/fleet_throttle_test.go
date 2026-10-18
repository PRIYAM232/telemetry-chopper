package filterprocessor

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"
)

// Issue #46: a THROTTLE rule's rate applied to each collector, so N gateway
// replicas admitted up to N × the rate.

func scopedThrottleRule(scope string, ratePerSec int, burstSeconds *int) PolicyRule {
	r := throttleRuleFor("limit-proxy", SignalLogs, ratePerSec, "", "service.name", OpEquals, "frontend-proxy")
	r.ThrottleScope = scope
	r.ThrottleBurstSeconds = burstSeconds
	return r
}

func TestThrottleScopeCollectorRate(t *testing.T) {
	for _, c := range []struct {
		scope      string
		collectors int
		want       float64
	}{
		{"", 4, 100},                     // older control plane: per collector
		{ThrottleScopeCollector, 4, 100}, // explicit per collector
		{ThrottleScopeFleet, 4, 25},      // fleet-wide: a quarter each
		{ThrottleScopeFleet, 3, 100.0 / 3},
		{ThrottleScopeFleet, 0, 100}, // no heartbeats yet: this collector alone
	} {
		got := compileRulesForFleet([]PolicyRule{scopedThrottleRule(c.scope, 100, nil)}, c.collectors, zap.NewNop())[0]
		if got.limiters == nil || got.collectorRate != c.want {
			t.Errorf("scope %q, %d collectors: collector rate %v (limiters %v), want %v", c.scope, c.collectors, got.collectorRate, got.limiters != nil, c.want)
		}
	}
}

// allowedInstantly floods each collector's bucket at once and returns how
// many events the fleet admitted: the buckets' burst, before any refill.
func allowedInstantly(t *testing.T, rule PolicyRule, collectors int) int {
	t.Helper()
	total := 0
	for c := 0; c < collectors; c++ {
		g := compileRulesForFleet([]PolicyRule{rule}, collectors, zap.NewNop())[0].limiters
		for i := 0; i < 10_000; i++ {
			if g.allow(throttleDefaultKey) {
				total++
			}
		}
	}
	return total
}

// The headline: with three collectors, a fleet-wide 30/s rule admits about
// 30 in its first second fleet-wide; a per-collector rule admits 90.
func TestFleetWideThrottleCapsTheFleet(t *testing.T) {
	fleet := allowedInstantly(t, scopedThrottleRule(ThrottleScopeFleet, 30, nil), 3)
	perCollector := allowedInstantly(t, scopedThrottleRule(ThrottleScopeCollector, 30, nil), 3)
	// A token or two may refill during the loop.
	if fleet < 30 || fleet > 32 {
		t.Errorf("fleet-wide 30/s across 3 collectors admitted %d, want ~30", fleet)
	}
	if perCollector < 90 || perCollector > 92 {
		t.Errorf("per-collector 30/s across 3 collectors admitted %d, want ~90", perCollector)
	}
}

func TestThrottleBurstSeconds(t *testing.T) {
	five := 5
	if n := allowedInstantly(t, scopedThrottleRule(ThrottleScopeCollector, 10, &five), 1); n < 50 || n > 51 {
		t.Errorf("10/s with a 5 s burst admitted %d at once, want ~50", n)
	}
	// Fractional shares round the bucket up to whole events, never to zero.
	g := newLimiterGroup(0.4, 1)
	if g.burst != 1 {
		t.Errorf("burst for 0.4/s = %d, want 1", g.burst)
	}
}

// A fleet-wide limit holds over time too, not just in the first burst.
func TestFleetWideThrottleSustainedRate(t *testing.T) {
	if testing.Short() {
		t.Skip("timing test")
	}
	rule := scopedThrottleRule(ThrottleScopeFleet, 40, nil)
	groups := []*limiterGroup{
		compileRulesForFleet([]PolicyRule{rule}, 2, zap.NewNop())[0].limiters,
		compileRulesForFleet([]PolicyRule{rule}, 2, zap.NewNop())[0].limiters,
	}
	total := 0
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, g := range groups {
			if g.allow(throttleDefaultKey) {
				total++
			}
		}
		time.Sleep(time.Millisecond)
	}
	// 40 of burst (20 + 20) plus ~40 refilled over the second.
	if total < 70 || total > 90 {
		t.Errorf("fleet-wide 40/s over 1 s on 2 collectors admitted %d, want ~80", total)
	}
}

func TestThrottleUnknownScopeIsUnsupported(t *testing.T) {
	c := compileRules([]PolicyRule{scopedThrottleRule("REGION", 10, nil)}, zap.NewNop())[0]
	if c.limiters != nil || ruleAppliesLogs(&c) {
		t.Error("a THROTTLE rule with an unknown scope must not be enforced")
	}
	if c.state != ruleStateUnsupported || c.stateReason != reasonThrottleScope {
		t.Errorf("status = %s/%s, want %s/%s", c.state, c.stateReason, ruleStateUnsupported, reasonThrottleScope)
	}
}

// The sync reads active_collectors and logs this collector's share.
func TestSyncOnceSplitsFleetWideThrottle(t *testing.T) {
	payload := FleetPolicyResponse{FleetID: "fleet", ActiveCollectors: 4, Rules: []PolicyRule{
		ruleWithID("t1", scopedThrottleRule(ThrottleScopeFleet, 100, nil)),
	}}
	body, _ := json.Marshal(payload)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(body) }))
	defer srv.Close()

	core, logs := observer.New(zapcore.InfoLevel)
	e := newRuleEngine(zap.New(core), &Config{SyncEndpoint: srv.URL, FleetKey: "k"})
	e.syncOnce(t.Context())

	if r := e.snapshotRules()[0].collectorRate; r != 25 {
		t.Errorf("collector rate = %v, want 25", r)
	}
	lines := logs.FilterMessage("chopper_filter policy sync: fleet-wide THROTTLE share").All()
	if len(lines) != 1 || lines[0].ContextMap()["active_collectors"] != int64(4) {
		t.Errorf("share log lines = %v", lines)
	}
}

func TestHeartbeatIdentifiesCollector(t *testing.T) {
	var got statsPayload
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	e := newRuleEngine(zap.NewNop(), &Config{StatsEndpoint: srv.URL, FleetKey: "k", StatsInterval: 10 * time.Second})
	res := pcommon.NewResource()
	res.Attributes().PutStr("service.instance.id", "gw-1")
	e.collectorID = collectorInstanceID(res)
	e.reportStatsOnce(t.Context())
	if got.CollectorID != "gw-1" || got.IntervalSeconds != 10 {
		t.Errorf("heartbeat collector_id=%q interval_seconds=%v, want gw-1/10", got.CollectorID, got.IntervalSeconds)
	}

	a, b := collectorInstanceID(pcommon.NewResource()), collectorInstanceID(pcommon.Resource{})
	if len(a) != 32 || len(b) != 32 || a == b {
		t.Errorf("fallback IDs %q, %q: want two distinct random 32-hex IDs", a, b)
	}
}
