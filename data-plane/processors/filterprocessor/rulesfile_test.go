package filterprocessor

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
)

// fullRulesFile exercises every action and the YAML conveniences: lowercase
// enums, a numeric value, a whole-trace SAMPLE without a condition, and a
// paused rule.
const fullRulesFile = `
rules:
  - name: drop-health-checks
    signal: traces
    action: drop
    when: { field: http.route, op: equals, value: /healthz }
  - name: drop-404s
    signal: traces
    action: drop
    when: { field: http.status_code, op: equals, value: 404 }
  - name: keep-10-percent
    signal: traces
    action: sample
    sample_rate: 0.1
  - name: sample-checkout-spans
    signal: traces
    action: sample
    sample_rate: 0.5
    sample_scope: span
    when: { field: service.name, op: equals, value: checkout }
  - name: mask-emails
    signal: logs
    action: REDACT
    when: { field: log.body, op: regex_match, value: '[a-z]+@example\.com', ignore_case: true }
  - name: archive-debug
    signal: logs
    action: route
    destination: cold-storage
    when: { field: log.severity, op: equals, value: debug, ignore_case: true }
  - name: cap-tenants
    signal: logs
    action: throttle
    throttle_rate: 100
    throttle_group_by: tenant_id
    when: { field: tenant_id, op: exists }
  - name: unindex-info
    signal: logs
    action: exclude_index
    when: { field: log.severity_number, op: less_than, value: 13 }
  - name: drop-cache-misses
    signal: metrics
    action: drop
    enabled: false
    when: { field: metric.name, op: contains, value: cache.misses }
`

func TestParseRulesFileFull(t *testing.T) {
	rules, err := parseRulesFile([]byte(fullRulesFile))
	if err != nil {
		t.Fatalf("parseRulesFile: %v", err)
	}
	if len(rules) != 9 {
		t.Fatalf("got %d rules, want 9", len(rules))
	}

	byName := map[string]PolicyRule{}
	for _, r := range rules {
		byName[r.Name] = r
	}

	drop404 := byName["drop-404s"]
	if drop404.ID != "traces/drop/drop-404s" || drop404.ActionType != ActionDrop || drop404.TargetSignal != SignalTraces {
		t.Errorf("drop-404s identity = %q %q %q", drop404.ID, drop404.ActionType, drop404.TargetSignal)
	}
	if drop404.ConditionOp != OpEquals || drop404.ConditionValue != "404" || !drop404.IsActive {
		t.Errorf("drop-404s condition = %q %q active=%v", drop404.ConditionOp, drop404.ConditionValue, drop404.IsActive)
	}

	whole := byName["keep-10-percent"]
	if whole.SampleScope != SampleScopeTrace || whole.SampleRate == nil || *whole.SampleRate != 0.1 {
		t.Errorf("keep-10-percent scope=%q rate=%v", whole.SampleScope, whole.SampleRate)
	}
	if whole.ConditionField != "" || whole.ConditionOp != OpExists {
		t.Errorf("whole-trace sample should carry the empty EXISTS condition, got %q %q", whole.ConditionField, whole.ConditionOp)
	}
	if got := byName["sample-checkout-spans"].SampleScope; got != SampleScopeSpan {
		t.Errorf("sample-checkout-spans scope = %q", got)
	}

	mask := byName["mask-emails"]
	if mask.ActionType != ActionRedact || mask.ConditionOp != OpRegexMatch || !mask.ConditionIgnoreCase {
		t.Errorf("mask-emails = %+v", mask)
	}
	if got := byName["archive-debug"].TargetDestination; got != "cold-storage" {
		t.Errorf("archive-debug destination = %q", got)
	}
	capT := byName["cap-tenants"]
	if capT.ThrottleRate == nil || *capT.ThrottleRate != 100 || capT.ThrottleGroupBy != "tenant_id" || capT.ConditionValue != "" {
		t.Errorf("cap-tenants = %+v", capT)
	}
	if byName["drop-cache-misses"].IsActive {
		t.Error("enabled: false should parse as a paused rule")
	}

	// Every rule compiles to the state the file implies: enforced, or
	// paused for the disabled one. Nothing invalid slips past validation.
	for _, c := range compileRules(rules, zap.NewNop()) {
		want := ruleStateEnforced
		if c.Name == "drop-cache-misses" {
			want = ruleStatePaused
		}
		if c.state != want {
			t.Errorf("rule %q compiled to state %q (%s), want %q", c.Name, c.state, c.stateReason, want)
		}
	}
}

func TestParseRulesFileEmpty(t *testing.T) {
	for _, doc := range []string{"", "# no rules yet\n", "rules: []\n"} {
		rules, err := parseRulesFile([]byte(doc))
		if err != nil || len(rules) != 0 {
			t.Errorf("parseRulesFile(%q) = %v, %v; want no rules, no error", doc, rules, err)
		}
	}
}

func TestParseRulesFileRejects(t *testing.T) {
	rule := func(body string) string { return "rules:\n  - name: r\n" + body }
	cases := []struct {
		name, doc, want string
	}{
		{"unknown key", rule("    signal: traces\n    action: drop\n    sample-rate: 0.1\n"), "field sample-rate not found"},
		{"missing name", "rules:\n  - signal: traces\n    action: drop\n", "rule 1: name is required"},
		{"duplicate name", "rules:\n  - {name: a, signal: traces, action: sample, sample_rate: 1}\n  - {name: a, signal: traces, action: sample, sample_rate: 1}\n", `rule 2 ("a"): name already used by rule 1`},
		{"missing signal", rule("    action: drop\n"), "signal is required"},
		{"unknown signal", rule("    signal: spans\n    action: drop\n"), `unknown signal "spans"`},
		{"unknown action", rule("    signal: traces\n    action: delete\n"), `unknown action "delete"`},
		{"sample on logs", rule("    signal: logs\n    action: sample\n    sample_rate: 0.5\n"), "action sample is not supported for logs"},
		{"redact on metrics", rule("    signal: metrics\n    action: redact\n    when: {field: a, op: exists}\n"), "action redact is not supported for metrics"},
		{"missing when", rule("    signal: traces\n    action: drop\n"), "when is required"},
		{"whole trace with when", rule("    signal: traces\n    action: sample\n    sample_rate: 0.5\n    when: {field: a, op: exists}\n"), "remove when, or set sample_scope: span"},
		{"missing sample rate", rule("    signal: traces\n    action: sample\n"), "sample_rate is required"},
		{"sample rate too big", rule("    signal: traces\n    action: sample\n    sample_rate: 10\n"), "at most 1, got 10"},
		{"sample rate zero", rule("    signal: traces\n    action: sample\n    sample_rate: 0\n"), "greater than 0"},
		{"bad scope", rule("    signal: traces\n    action: sample\n    sample_rate: 0.5\n    sample_scope: resource\n"), `unknown sample_scope "resource"`},
		{"rate on drop", rule("    signal: traces\n    action: drop\n    sample_rate: 0.5\n    when: {field: a, op: exists}\n"), "sample_rate only applies to sample rules"},
		{"missing destination", rule("    signal: logs\n    action: route\n    when: {field: a, op: exists}\n"), "destination is required"},
		{"bad destination", rule("    signal: logs\n    action: route\n    destination: cold storage\n    when: {field: a, op: exists}\n"), "destination is required"},
		{"missing throttle rate", rule("    signal: logs\n    action: throttle\n    when: {field: a, op: exists}\n"), "throttle_rate is required"},
		{"bad group by", rule("    signal: logs\n    action: throttle\n    throttle_rate: 5\n    throttle_group_by: 'tenant id'\n    when: {field: a, op: exists}\n"), "throttle_group_by must be an attribute key"},
		{"missing field", rule("    signal: traces\n    action: drop\n    when: {op: exists}\n"), "when: field is required"},
		{"unknown op", rule("    signal: traces\n    action: drop\n    when: {field: a, op: startswith, value: x}\n"), `unknown op "startswith"`},
		{"missing value", rule("    signal: traces\n    action: drop\n    when: {field: a, op: equals}\n"), "value is required for equals"},
		{"null value", rule("    signal: traces\n    action: drop\n    when: {field: a, op: equals, value: }\n"), "value is required for equals"},
		{"list value", rule("    signal: traces\n    action: drop\n    when: {field: a, op: equals, value: [1, 2]}\n"), "value must be a single value"},
		{"exists with value", rule("    signal: traces\n    action: drop\n    when: {field: a, op: exists, value: x}\n"), "exists takes no value"},
		{"non-numeric threshold", rule("    signal: traces\n    action: drop\n    when: {field: a, op: greater_than, value: big}\n"), `greater_than needs a number value, got "big"`},
		{"lookahead regex", rule("    signal: traces\n    action: drop\n    when: {field: a, op: regex_match, value: '(?=x)'}\n"), "not a valid RE2 regular expression"},
		{"ignore case on exists", rule("    signal: traces\n    action: drop\n    when: {field: a, op: exists, ignore_case: true}\n"), "ignore_case only applies"},
		{"not yaml", "rules: [", "invalid YAML"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := parseRulesFile([]byte(c.doc))
			if err == nil {
				t.Fatalf("parseRulesFile accepted:\n%s", c.doc)
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Fatalf("error %q does not mention %q", err, c.want)
			}
		})
	}
}

func writeRulesFile(t *testing.T, dir, body string) string {
	t.Helper()
	path := filepath.Join(dir, "rules.yaml")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestConfigValidateRulesFile(t *testing.T) {
	dir := t.TempDir()
	good := writeRulesFile(t, dir, "rules:\n  - {name: a, signal: traces, action: sample, sample_rate: 0.5}\n")
	bad := filepath.Join(dir, "bad.yaml")
	if err := os.WriteFile(bad, []byte("rules:\n  - {name: a, signal: traces, action: drop}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name string
		cfg  Config
		want string // "" = valid
	}{
		{"valid", Config{RulesFile: good, RulesFileCheckInterval: 5 * time.Second}, ""},
		{"read once", Config{RulesFile: good}, ""},
		{"invalid rule", Config{RulesFile: bad}, `rule 1 ("a"): when is required`},
		{"missing file", Config{RulesFile: filepath.Join(dir, "nope.yaml")}, "no such file"},
		{"with sync", Config{RulesFile: good, SyncEndpoint: "http://cp/api", SyncInterval: time.Second, FleetKey: "k"}, "can't be combined"},
		{"with stats", Config{RulesFile: good, StatsEndpoint: "http://cp/api", StatsInterval: time.Second, FleetKey: "k"}, "can't be combined"},
		{"interval too short", Config{RulesFile: good, RulesFileCheckInterval: time.Millisecond}, "rules_file_check_interval"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := c.cfg.Validate()
			switch {
			case c.want == "" && err != nil:
				t.Fatalf("Validate: %v", err)
			case c.want != "" && (err == nil || !strings.Contains(err.Error(), c.want)):
				t.Fatalf("Validate error %v, want one mentioning %q", err, c.want)
			}
		})
	}
}

// spanBatch returns one batch with a span per route.
func spanBatch(routes ...string) ptrace.Traces {
	td := ptrace.NewTraces()
	ss := td.ResourceSpans().AppendEmpty().ScopeSpans().AppendEmpty().Spans()
	for i, route := range routes {
		span := ss.AppendEmpty()
		span.SetTraceID(traceIDFromByte(byte(i)))
		span.Attributes().PutStr("http.route", route)
	}
	return td
}

// TestRulesFileEngineLifecycle runs the engine the way the collector does:
// start loads the file and enforces it, an edit is picked up without a
// restart, a broken edit keeps the last good rules, and fixing it resumes.
func TestRulesFileEngineLifecycle(t *testing.T) {
	dir := t.TempDir()
	path := writeRulesFile(t, dir, `
rules:
  - name: drop-health
    signal: traces
    action: drop
    when: { field: http.route, op: equals, value: /healthz }
`)
	core, logs := observer.New(zap.InfoLevel)
	engine := newRuleEngine(zap.New(core), &Config{RulesFile: path, RulesFileCheckInterval: time.Second})
	p := newTestProcessor(t, nil)
	p.engine = engine

	if err := p.Start(context.Background(), nil); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = p.Shutdown(context.Background()) }()

	td := spanBatch("/healthz", "/checkout", "/ready")
	if err := p.ConsumeTraces(context.Background(), td); err != nil {
		t.Fatal(err)
	}
	if got := td.SpanCount(); got != 2 {
		t.Fatalf("after start: %d spans survive, want 2 (only /healthz dropped)", got)
	}

	// Edit: also drop /ready. Reloads are driven directly so the test
	// doesn't wait on the ticker.
	writeRulesFile(t, dir, `
rules:
  - name: drop-health
    signal: traces
    action: drop
    when: { field: http.route, op: regex_match, value: '^/(healthz|ready)$' }
`)
	engine.reloadRulesFile()
	td = spanBatch("/healthz", "/checkout", "/ready")
	_ = p.ConsumeTraces(context.Background(), td)
	if got := td.SpanCount(); got != 1 {
		t.Fatalf("after edit: %d spans survive, want 1", got)
	}

	// A broken edit is logged once and the previous rules stay in force.
	writeRulesFile(t, dir, "rules:\n  - name: drop-health\n    signal: traces\n    action: drop\n")
	engine.reloadRulesFile()
	engine.reloadRulesFile()
	if n := logs.FilterMessage(rulesFileLogPrefix + "not applied, keeping the current rules").Len(); n != 1 {
		t.Fatalf("broken file logged %d times, want once", n)
	}
	td = spanBatch("/healthz", "/checkout", "/ready")
	_ = p.ConsumeTraces(context.Background(), td)
	if got := td.SpanCount(); got != 1 {
		t.Fatalf("after broken edit: %d spans survive, want 1 (last good rules kept)", got)
	}

	// Emptying the file is a valid edit: no rules, everything passes.
	writeRulesFile(t, dir, "rules: []\n")
	engine.reloadRulesFile()
	if logs.FilterMessage(rulesFileLogPrefix+"valid again").Len() != 1 {
		t.Error("recovery from a broken file was not logged")
	}
	td = spanBatch("/healthz", "/checkout", "/ready")
	_ = p.ConsumeTraces(context.Background(), td)
	if got := td.SpanCount(); got != 3 {
		t.Fatalf("after emptying the file: %d spans survive, want 3", got)
	}
	if n := logs.FilterMessage(rulesFileLogPrefix + "ruleset updated").Len(); n != 3 {
		t.Errorf("logged %d ruleset updates, want 3 (start, edit, empty)", n)
	}
}

func TestRulesFileStartFailsOnBrokenFile(t *testing.T) {
	path := writeRulesFile(t, t.TempDir(), "rules:\n  - name: x\n")
	engine := newRuleEngine(zap.NewNop(), &Config{RulesFile: path})
	p := newTestProcessor(t, nil)
	p.engine = engine
	if err := p.Start(context.Background(), nil); err == nil {
		t.Fatal("Start succeeded with an invalid rules file")
	}
	// A failed start must not leave the engine half-registered.
	if engine.refs != 0 {
		t.Fatalf("refs = %d after failed start, want 0", engine.refs)
	}
}

// TestRulesFileReloadLoopPicksUpEdits checks the real ticker path once.
func TestRulesFileReloadLoopPicksUpEdits(t *testing.T) {
	dir := t.TempDir()
	path := writeRulesFile(t, dir, "rules: []\n")
	engine := newRuleEngine(zap.NewNop(), &Config{RulesFile: path, RulesFileCheckInterval: time.Second})
	if err := engine.start(); err != nil {
		t.Fatal(err)
	}
	defer engine.stop()

	writeRulesFile(t, dir, "rules:\n  - {name: keep-half, signal: traces, action: sample, sample_rate: 0.5}\n")
	deadline := time.Now().Add(5 * time.Second)
	for len(engine.snapshotRules()) != 1 {
		if time.Now().After(deadline) {
			t.Fatal("edit not picked up within 5s")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// TestShippedExampleRulesFileIsValid keeps the example the packages install
// as /etc/telemetry-chopper/rules.yaml in step with the parser.
func TestShippedExampleRulesFileIsValid(t *testing.T) {
	rules, _, err := loadRulesFile(filepath.Join("..", "..", "config", "rules.example.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if len(rules) == 0 {
		t.Fatal("example rules file has no rules")
	}
}
