package filterprocessor

import (
	"context"
	"testing"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.uber.org/zap"
)

// Issue #47: the OpenTelemetry Demo spells one level three ways.
var demoSeverities = []string{"INFO", "info", "Information"}

func compiledOne(t *testing.T, r PolicyRule) *compiledRule {
	t.Helper()
	c := compileRules([]PolicyRule{r}, zap.NewNop())
	return &c[0]
}

func TestIgnoreCaseOperators(t *testing.T) {
	cases := []struct {
		op, value  string
		ignoreCase bool
		in         string
		want       bool
	}{
		{OpEquals, "INFO", false, "info", false},
		{OpEquals, "INFO", true, "info", true},
		{OpEquals, "INFO", true, "Info", true},
		{OpEquals, "INFO", true, "Information", false},
		{OpContains, "Timeout", false, "upstream TIMEOUT after 5s", false},
		{OpContains, "Timeout", true, "upstream TIMEOUT after 5s", true},
		{OpContains, "Timeout", true, "upstream time out", false},
		// CONTAINS is literal: regex metacharacters in the value aren't special.
		{OpContains, "a.b(", true, "X A.B( y", true},
		{OpContains, "a.b(", true, "aXb(", false},
		{OpRegexMatch, "^info", false, "Information", false},
		{OpRegexMatch, "^info", true, "Information", true},
		{OpRegexMatch, "^info", true, "debug info", false},
		// Unicode simple folding, the same in EqualFold and (?i).
		{OpEquals, "straße", true, "STRAßE", true},
		{OpContains, "ÉCHEC", true, "paiement échec", true},
		// Operators without a case have nothing to ignore.
		{OpExists, "", true, "anything", true},
		{OpGreaterThan, "10", true, "11", true},
	}
	for _, c := range cases {
		r := compiledOne(t, PolicyRule{ConditionOp: c.op, ConditionValue: c.value, ConditionIgnoreCase: c.ignoreCase})
		if got := matchConditionString(r, c.in); got != c.want {
			t.Errorf("%s %q ignoreCase=%v on %q: got %v, want %v", c.op, c.value, c.ignoreCase, c.in, got, c.want)
		}
		v := pcommon.NewValueStr(c.in)
		if got := matchConditionValue(r, v); got != c.want {
			t.Errorf("value path: %s %q ignoreCase=%v on %q: got %v, want %v", c.op, c.value, c.ignoreCase, c.in, got, c.want)
		}
	}
}

func TestLessThanOperator(t *testing.T) {
	r := compiledOne(t, PolicyRule{ConditionOp: OpLessThan, ConditionValue: "13"})
	for in, want := range map[string]bool{"12": true, "13": false, "1.5": true, "x": false} {
		if got := matchConditionString(r, in); got != want {
			t.Errorf("LESS_THAN 13 on %q: got %v, want %v", in, got, want)
		}
	}
	if !matchConditionValue(r, pcommon.NewValueInt(9)) || matchConditionValue(r, pcommon.NewValueDouble(13.5)) {
		t.Error("LESS_THAN 13 on Int(9)/Double(13.5) wrong")
	}
	bad := compiledOne(t, PolicyRule{ConditionOp: OpLessThan, ConditionValue: "thirteen"})
	if matchConditionString(bad, "1") {
		t.Error("LESS_THAN with a non-numeric value must never match")
	}
}

// The demo case end to end: one ignore-case rule drops every spelling.
func TestLogsSeverityIgnoreCaseDropsEverySpelling(t *testing.T) {
	for _, c := range []struct {
		ignoreCase bool
		wantLeft   int
	}{{false, 3}, {true, 1}} {
		r := dropLogsRule("drop-info", fieldLogSeverity, OpRegexMatch, "^info")
		r.ConditionIgnoreCase = c.ignoreCase
		p := newTestLogsProcessor(t, []PolicyRule{r})
		ld := plog.NewLogs()
		slr := ld.ResourceLogs().AppendEmpty().ScopeLogs().AppendEmpty().LogRecords()
		for _, s := range demoSeverities {
			addLogRecord(slr, s, "msg")
		}
		addLogRecord(slr, "ERROR", "boom")
		if err := p.ConsumeLogs(context.Background(), ld); err != nil {
			t.Fatal(err)
		}
		if n := ld.LogRecordCount(); n != c.wantLeft {
			t.Errorf("ignoreCase=%v: %d records left, want %d", c.ignoreCase, n, c.wantLeft)
		}
	}
}

// log.severity_number: "INFO and below" regardless of how the text is spelled.
func TestLogsSeverityNumberLessThan(t *testing.T) {
	p := newTestLogsProcessor(t, []PolicyRule{dropLogsRule("drop-info-and-below", fieldLogSeverityNumber, OpLessThan, "13")})
	ld := plog.NewLogs()
	slr := ld.ResourceLogs().AppendEmpty().ScopeLogs().AppendEmpty().LogRecords()
	for _, c := range []struct {
		text string
		num  plog.SeverityNumber
	}{
		{"DEBUG", plog.SeverityNumberDebug},
		{"INFO", plog.SeverityNumberInfo},
		{"Information", plog.SeverityNumberInfo},
		{"WARN", plog.SeverityNumberWarn},
		{"ERROR", plog.SeverityNumberError},
		{"", plog.SeverityNumberUnspecified}, // no number: absent, never matches
	} {
		addLogRecord(slr, c.text, "msg").SetSeverityNumber(c.num)
	}
	if err := p.ConsumeLogs(context.Background(), ld); err != nil {
		t.Fatal(err)
	}
	var left []string
	recs := ld.ResourceLogs().At(0).ScopeLogs().At(0).LogRecords()
	for i := 0; i < recs.Len(); i++ {
		left = append(left, recs.At(i).SeverityText())
	}
	if len(left) != 3 || left[0] != "WARN" || left[1] != "ERROR" || left[2] != "" {
		t.Errorf("records left = %q, want [WARN ERROR \"\"]", left)
	}
}

func TestLogsSeverityNumberEqualsAndExists(t *testing.T) {
	lr := plog.NewLogRecord()
	lr.SetSeverityNumber(plog.SeverityNumberError)
	res := pcommon.NewMap()
	eq := compiledOne(t, PolicyRule{ConditionField: fieldLogSeverityNumber, ConditionOp: OpEquals, ConditionValue: "17"})
	ex := compiledOne(t, PolicyRule{ConditionField: fieldLogSeverityNumber, ConditionOp: OpExists})
	if !logConditionMatches(eq, lr, res) || !logConditionMatches(ex, lr, res) {
		t.Error("severity_number EQUALS 17 / EXISTS should match an ERROR record")
	}
	lr.SetSeverityNumber(plog.SeverityNumberUnspecified)
	if logConditionMatches(ex, lr, res) {
		t.Error("EXISTS must not match UNSPECIFIED")
	}
}

// REDACT with an ignore-case REGEX_MATCH masks every casing of the match.
func TestIgnoreCaseRegexRedactMasksEveryCasing(t *testing.T) {
	r := regexRedactRule("mask-token", fieldLogBody, `token=\w+`)
	r.ConditionIgnoreCase = true
	p := newTestLogsProcessor(t, []PolicyRule{r})
	ld := plog.NewLogs()
	slr := ld.ResourceLogs().AppendEmpty().ScopeLogs().AppendEmpty().LogRecords()
	addLogRecord(slr, "INFO", "a token=abc b TOKEN=def c Token=ghi")
	if err := p.ConsumeLogs(context.Background(), ld); err != nil {
		t.Fatal(err)
	}
	want := "a [REDACTED_PATTERN] b [REDACTED_PATTERN] c [REDACTED_PATTERN]"
	if got := firstLogRecord(t, ld).Body().Str(); got != want {
		t.Errorf("body = %q, want %q", got, want)
	}
}

// The case-insensitive paths stay allocation-free on the hot path.
func TestIgnoreCaseMatchingDoesNotAllocate(t *testing.T) {
	eq := compiledOne(t, PolicyRule{ConditionOp: OpEquals, ConditionValue: "INFO", ConditionIgnoreCase: true})
	co := compiledOne(t, PolicyRule{ConditionOp: OpContains, ConditionValue: "timeout", ConditionIgnoreCase: true})
	lt := compiledOne(t, PolicyRule{ConditionOp: OpLessThan, ConditionValue: "13"})
	allocs := testing.AllocsPerRun(1000, func() {
		matchConditionString(eq, "info")
		matchConditionString(co, "upstream TIMEOUT after 5s")
		matchConditionNumber(lt, 9)
	})
	if allocs != 0 {
		t.Errorf("allocs per run = %v, want 0", allocs)
	}
}
