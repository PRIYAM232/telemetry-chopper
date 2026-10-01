package filterprocessor

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"
)

func statusOf(r PolicyRule) (string, string) {
	c := compileRules([]PolicyRule{r}, zap.NewNop())
	return c[0].state, c[0].stateReason
}

func TestRuleStatusStatesAndReasons(t *testing.T) {
	rate := 0.5
	zero := 0
	base := PolicyRule{IsActive: true, Name: "r", ConditionField: "f", ConditionOp: OpEquals, ConditionValue: "v"}
	with := func(f func(*PolicyRule)) PolicyRule { r := base; f(&r); return r }

	cases := []struct {
		name         string
		rule         PolicyRule
		state, cause string
	}{
		{"enforced drop", with(func(r *PolicyRule) { r.ActionType, r.TargetSignal = ActionDrop, SignalTraces }), ruleStateEnforced, ""},
		{"paused broken regex is paused, not invalid", with(func(r *PolicyRule) {
			r.IsActive = false
			r.ActionType, r.TargetSignal, r.ConditionOp, r.ConditionValue = ActionDrop, SignalLogs, OpRegexMatch, "(?=x)"
		}), ruleStatePaused, ""},
		{"paused good rule", with(func(r *PolicyRule) { r.IsActive = false; r.ActionType, r.TargetSignal = ActionDrop, SignalTraces }), ruleStatePaused, ""},
		{"bad regex", with(func(r *PolicyRule) {
			r.ActionType, r.TargetSignal, r.ConditionOp, r.ConditionValue = ActionDrop, SignalLogs, OpRegexMatch, "(?=x)"
		}), ruleStateInvalid, reasonRegexInvalid},
		{"sample without rate", with(func(r *PolicyRule) { r.ActionType, r.TargetSignal = ActionSample, SignalTraces }), ruleStateInvalid, reasonMissingSampleRate},
		{"route without destination", with(func(r *PolicyRule) { r.ActionType, r.TargetSignal = ActionRoute, SignalMetrics }), ruleStateInvalid, reasonMissingDestination},
		{"throttle with zero rate", with(func(r *PolicyRule) { r.ActionType, r.TargetSignal, r.ThrottleRate = ActionThrottle, SignalLogs, &zero }), ruleStateInvalid, reasonMissingRate},
		{"sample on logs", with(func(r *PolicyRule) { r.ActionType, r.TargetSignal, r.SampleRate = ActionSample, SignalLogs, &rate }), ruleStateUnsupported, reasonActionNotSupported},
		{"redact on metrics", with(func(r *PolicyRule) { r.ActionType, r.TargetSignal = ActionRedact, SignalMetrics }), ruleStateUnsupported, reasonActionNotSupported},
		{"exclude_index on metrics", with(func(r *PolicyRule) { r.ActionType, r.TargetSignal = ActionExcludeIndex, SignalMetrics }), ruleStateUnsupported, reasonActionNotSupported},
		{"action from a newer control plane", with(func(r *PolicyRule) { r.ActionType, r.TargetSignal = "ENRICH", SignalTraces }), ruleStateUnsupported, reasonActionNotSupported},
		{"signal from a newer control plane", with(func(r *PolicyRule) { r.ActionType, r.TargetSignal = ActionDrop, "PROFILES" }), ruleStateUnsupported, reasonUnknownSignal},
	}
	for _, c := range cases {
		state, reason := statusOf(c.rule)
		if state != c.state || reason != c.cause {
			t.Errorf("%s: got %s/%q, want %s/%q", c.name, state, reason, c.state, c.cause)
		}
	}
}

// "enforced" must mean exactly what the hot path does: some ruleApplies*
// gate accepts the rule. Checked over every signal × action × parameter ×
// active combination, so the status can never drift from enforcement.
func TestRuleStatusAgreesWithEnforcementGates(t *testing.T) {
	rate, thr, zero := 0.5, 10, 0
	signals := []string{SignalTraces, SignalLogs, SignalMetrics, "PROFILES"}
	actions := []string{ActionDrop, ActionSample, ActionRedact, ActionRoute, ActionThrottle, ActionExcludeIndex, "ENRICH"}
	n := 0
	for _, active := range []bool{true, false} {
		for _, sig := range signals {
			for _, act := range actions {
				for _, sampleRate := range []*float64{nil, &rate} {
					for _, dest := range []string{"", "cold"} {
						for _, throttle := range []*int{nil, &zero, &thr} {
							for _, pattern := range []string{"", "ok.*", "(?=bad)"} {
								r := PolicyRule{
									IsActive: active, Name: "r", ActionType: act, TargetSignal: sig,
									SampleRate: sampleRate, TargetDestination: dest, ThrottleRate: throttle,
									ConditionField: "f", ConditionOp: OpEquals, ConditionValue: "v",
								}
								if pattern != "" {
									r.ConditionOp, r.ConditionValue = OpRegexMatch, pattern
								}
								c := compileRules([]PolicyRule{r}, zap.NewNop())[0]
								applies := ruleAppliesTraces(&c) || ruleAppliesLogs(&c) || ruleAppliesMetrics(&c)
								if (c.state == ruleStateEnforced) != applies {
									t.Fatalf("%+v: state %s but enforced by a gate = %v", r, c.state, applies)
								}
								if (c.state == ruleStatePaused) != !active {
									t.Fatalf("%+v: state %s but isActive = %v", r, c.state, active)
								}
								if c.state != ruleStateEnforced && c.state != ruleStatePaused && c.stateReason == "" {
									t.Fatalf("%+v: state %s without a reason", r, c.state)
								}
								n++
							}
						}
					}
				}
			}
		}
	}
	if n != 2*4*7*2*2*3*3 {
		t.Fatalf("checked %d combinations", n)
	}
}

// The sync log separates paused rules from broken ones and names every
// broken rule; paused rules raise no warning.
func TestSyncOnceLogsEnforcementStatus(t *testing.T) {
	rate := 0.5
	payload := FleetPolicyResponse{FleetID: "fleet", Rules: []PolicyRule{
		{ID: "1", IsActive: true, Name: "drop-404", ActionType: ActionDrop, TargetSignal: SignalTraces, ConditionField: "s", ConditionOp: OpEquals, ConditionValue: "404"},
		{ID: "2", IsActive: false, Name: "paused-throttle", ActionType: ActionDrop, TargetSignal: SignalLogs, ConditionField: "t", ConditionOp: OpEquals, ConditionValue: "x"},
		{ID: "3", IsActive: true, Name: "bad-regex", ActionType: ActionDrop, TargetSignal: SignalLogs, ConditionField: "log.body", ConditionOp: OpRegexMatch, ConditionValue: "(?=x)"},
		{ID: "4", IsActive: true, Name: "sample-logs", ActionType: ActionSample, SampleRate: &rate, TargetSignal: SignalLogs, ConditionField: "a", ConditionOp: OpExists},
		{ID: "5", IsActive: true, Name: "drop-gauge", ActionType: ActionDrop, TargetSignal: SignalMetrics, ConditionField: "metric.name", ConditionOp: OpEquals, ConditionValue: "g"},
	}}
	body, _ := json.Marshal(payload)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(body) }))
	defer srv.Close()

	core, logs := observer.New(zapcore.InfoLevel)
	e := newRuleEngine(zap.New(core), &Config{SyncEndpoint: srv.URL, FleetKey: "k"})
	e.syncOnce(t.Context())

	updated := logs.FilterMessage("chopper_filter policy sync: ruleset updated").All()
	if len(updated) != 1 {
		t.Fatalf("ruleset updated lines = %d, want 1", len(updated))
	}
	fields := updated[0].ContextMap()
	want := map[string]int64{
		"rules_total": 5, "rules_enforced_traces": 1, "rules_enforced_logs": 0, "rules_enforced_metrics": 1,
		"rules_paused": 1, "rules_invalid": 1, "rules_unsupported": 1,
	}
	for k, v := range want {
		if got, ok := fields[k].(int64); !ok || got != v {
			t.Errorf("%s = %v, want %d", k, fields[k], v)
		}
	}
	if _, ok := fields["rules_ignored"]; ok {
		t.Error("rules_ignored is still logged; it conflated paused and broken rules")
	}

	warned := map[string]string{}
	for _, entry := range logs.FilterMessage("chopper_filter policy sync: rule not enforced").All() {
		m := entry.ContextMap()
		warned[m["rule"].(string)] = m["state"].(string) + "/" + m["reason"].(string)
	}
	wantWarned := map[string]string{
		"bad-regex":   ruleStateInvalid + "/" + reasonRegexInvalid,
		"sample-logs": ruleStateUnsupported + "/" + reasonActionNotSupported,
	}
	if len(warned) != len(wantWarned) {
		t.Errorf("warned rules = %v, want %v (paused rules must not warn)", warned, wantWarned)
	}
	for rule, w := range wantWarned {
		if warned[rule] != w {
			t.Errorf("warning for %s = %q, want %q", rule, warned[rule], w)
		}
	}
}
