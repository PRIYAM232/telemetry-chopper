package filterprocessor

import (
	"context"
	"fmt"
	"testing"

	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/ptrace"
)

// Hot-path benchmarks: one batch through Consume{Traces,Logs,Metrics} per
// iteration, one sub-benchmark per rule shape so a regression points at the
// operator or action that caused it. Run them with `make bench`, or:
//
//	go test -run '^$' -bench . -benchmem -benchtime=2000x
//
// A time-based -benchtime runs for minutes, because each iteration copies a
// fresh batch with the timer stopped.
//
// Compare before and after a change with benchstat. allocs/op is per batch,
// and ns/record divides the batch time by its record count.

const benchBatchSize = 1000

func benchRule(name, signal, action, field, op, value string) PolicyRule {
	return PolicyRule{
		IsActive:       true,
		Name:           name,
		ActionType:     action,
		TargetSignal:   signal,
		ConditionField: field,
		ConditionOp:    op,
		ConditionValue: value,
	}
}

func benchSampleRule(rate float64) PolicyRule {
	r := benchRule("sample-half", SignalTraces, ActionSample, "http.route", OpExists, "")
	r.SampleRate = &rate
	r.SampleScope = SampleScopeTrace
	return r
}

func benchThrottleRule(signal string) PolicyRule {
	// Far above anything a benchmark run sends, so nothing is throttled even
	// over millions of iterations: this measures the bucket lookup every
	// matching record pays, not the drop.
	rate := 1_000_000_000
	r := benchRule("throttle", signal, ActionThrottle, "service.tier", OpExists, "")
	r.ThrottleRate = &rate
	return r
}

// benchTraces is n spans, 10 per trace, under one resource: 10% health
// checks, 5% server errors, every span with a user email, 5% with a card
// number.
func benchTraces(n int) ptrace.Traces {
	td := ptrace.NewTraces()
	rs := td.ResourceSpans().AppendEmpty()
	rs.Resource().Attributes().PutStr("service.name", "checkout")
	rs.Resource().Attributes().PutStr("service.tier", "web")
	spans := rs.ScopeSpans().AppendEmpty().Spans()
	spans.EnsureCapacity(n)
	for i := range n {
		span := spans.AppendEmpty()
		span.SetTraceID(traceIDFromByte(byte(i / 10)))
		span.SetName("GET /api/orders/{id}")
		attrs := span.Attributes()
		route, status := "/api/orders/{id}", int64(200)
		if i%10 == 0 {
			route = "/healthz"
		}
		if i%20 == 1 {
			status = 500
		}
		attrs.PutStr("http.route", route)
		attrs.PutInt("http.status_code", status)
		attrs.PutStr("user.email", fmt.Sprintf("user%d@example.com", i))
		if i%20 == 2 {
			attrs.PutStr("payment.card", "card 4111 1111 1111 1111 on file")
		}
	}
	return td
}

// benchLogs is n records under one resource: 80% INFO, 20% ERROR, 10%
// health-check bodies, 5% with a card number in the body.
func benchLogs(n int) plog.Logs {
	ld := plog.NewLogs()
	rl := ld.ResourceLogs().AppendEmpty()
	rl.Resource().Attributes().PutStr("service.name", "checkout")
	rl.Resource().Attributes().PutStr("service.tier", "web")
	records := rl.ScopeLogs().AppendEmpty().LogRecords()
	records.EnsureCapacity(n)
	for i := range n {
		lr := records.AppendEmpty()
		lr.SetSeverityText("INFO")
		lr.SetSeverityNumber(plog.SeverityNumberInfo)
		if i%5 == 0 {
			lr.SetSeverityText("ERROR")
			lr.SetSeverityNumber(plog.SeverityNumberError)
		}
		body := fmt.Sprintf("order %d placed by user%d@example.com", i, i)
		switch {
		case i%10 == 1:
			body = "healthcheck ok"
		case i%20 == 2:
			body = fmt.Sprintf("payment for order %d with card 4111 1111 1111 1111", i)
		}
		lr.Body().SetStr(body)
		lr.Attributes().PutStr("http.route", "/api/orders/{id}")
	}
	return ld
}

// benchMetrics is n single-datapoint gauges under one resource, 10% of them
// debug metrics.
func benchMetrics(n int) pmetric.Metrics {
	md := pmetric.NewMetrics()
	rm := md.ResourceMetrics().AppendEmpty()
	rm.Resource().Attributes().PutStr("service.name", "checkout")
	rm.Resource().Attributes().PutStr("service.tier", "web")
	ms := rm.ScopeMetrics().AppendEmpty().Metrics()
	ms.EnsureCapacity(n)
	for i := range n {
		name := fmt.Sprintf("http.server.duration.%d", i)
		if i%10 == 0 {
			name = fmt.Sprintf("debug.queue.depth.%d", i)
		}
		m := ms.AppendEmpty()
		m.SetName(name)
		m.SetEmptyGauge().DataPoints().AppendEmpty().SetIntValue(int64(i))
	}
	return md
}

// reportPerRecord adds ns/record next to ns/op so batch sizes can change
// without invalidating comparisons.
func reportPerRecord(b *testing.B) {
	b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N*benchBatchSize), "ns/record")
}

func BenchmarkConsumeTraces(b *testing.B) {
	const card = `\b(?:\d[ -]?){15}\d\b`
	cases := []struct {
		name  string
		rules []PolicyRule
	}{
		{"no-rules", nil},
		{"no-match", []PolicyRule{benchRule("never", SignalTraces, ActionDrop, "http.route", OpEquals, "/never")}},
		{"drop-equals", []PolicyRule{benchRule("healthz", SignalTraces, ActionDrop, "http.route", OpEquals, "/healthz")}},
		{"drop-greater-than", []PolicyRule{benchRule("errors", SignalTraces, ActionDrop, "http.status_code", OpGreaterThan, "499")}},
		{"sample-whole-trace", []PolicyRule{benchSampleRule(0.5)}},
		{"redact-exists", []PolicyRule{benchRule("email", SignalTraces, ActionRedact, "user.email", OpExists, "")}},
		{"redact-regex", []PolicyRule{benchRule("card", SignalTraces, ActionRedact, "payment.card", OpRegexMatch, card)}},
		{"exclude-index", []PolicyRule{benchRule("ok", SignalTraces, ActionExcludeIndex, "http.status_code", OpLessThan, "400")}},
		{"throttle", []PolicyRule{benchThrottleRule(SignalTraces)}},
		{"mixed", []PolicyRule{
			benchRule("healthz", SignalTraces, ActionDrop, "http.route", OpEquals, "/healthz"),
			benchRule("email", SignalTraces, ActionRedact, "user.email", OpExists, ""),
			benchRule("card", SignalTraces, ActionRedact, "payment.card", OpRegexMatch, card),
			benchRule("ok", SignalTraces, ActionExcludeIndex, "http.status_code", OpLessThan, "400"),
			benchThrottleRule(SignalTraces),
		}},
	}
	src := benchTraces(benchBatchSize)
	for _, tc := range cases {
		b.Run(tc.name, func(b *testing.B) {
			p := newTestProcessor(b, tc.rules)
			ctx := context.Background()
			b.ReportAllocs()
			b.ResetTimer()
			for range b.N {
				b.StopTimer()
				td := ptrace.NewTraces()
				src.CopyTo(td)
				b.StartTimer()
				if err := p.ConsumeTraces(ctx, td); err != nil {
					b.Fatal(err)
				}
			}
			reportPerRecord(b)
		})
	}
}

func BenchmarkConsumeLogs(b *testing.B) {
	const card = `\b(?:\d[ -]?){15}\d\b`
	ignoreCase := benchRule("info", SignalLogs, ActionDrop, fieldLogSeverity, OpEquals, "info")
	ignoreCase.ConditionIgnoreCase = true
	cases := []struct {
		name  string
		rules []PolicyRule
	}{
		{"no-rules", nil},
		{"no-match", []PolicyRule{benchRule("never", SignalLogs, ActionDrop, "http.route", OpEquals, "/never")}},
		{"drop-severity-number", []PolicyRule{benchRule("info-and-below", SignalLogs, ActionDrop, fieldLogSeverityNumber, OpLessThan, "13")}},
		{"drop-severity-ignore-case", []PolicyRule{ignoreCase}},
		{"drop-body-contains", []PolicyRule{benchRule("healthcheck", SignalLogs, ActionDrop, fieldLogBody, OpContains, "healthcheck")}},
		{"redact-body-regex", []PolicyRule{benchRule("card", SignalLogs, ActionRedact, fieldLogBody, OpRegexMatch, card)}},
		{"throttle", []PolicyRule{benchThrottleRule(SignalLogs)}},
	}
	src := benchLogs(benchBatchSize)
	for _, tc := range cases {
		b.Run(tc.name, func(b *testing.B) {
			p := newTestLogsProcessor(b, tc.rules)
			ctx := context.Background()
			b.ReportAllocs()
			b.ResetTimer()
			for range b.N {
				b.StopTimer()
				ld := plog.NewLogs()
				src.CopyTo(ld)
				b.StartTimer()
				if err := p.ConsumeLogs(ctx, ld); err != nil {
					b.Fatal(err)
				}
			}
			reportPerRecord(b)
		})
	}
}

func BenchmarkConsumeMetrics(b *testing.B) {
	cases := []struct {
		name  string
		rules []PolicyRule
	}{
		{"no-rules", nil},
		{"no-match", []PolicyRule{benchRule("never", SignalMetrics, ActionDrop, fieldMetricName, OpEquals, "never")}},
		{"drop-name-regex", []PolicyRule{benchRule("debug", SignalMetrics, ActionDrop, fieldMetricName, OpRegexMatch, `^debug\.`)}},
		{"throttle", []PolicyRule{benchThrottleRule(SignalMetrics)}},
	}
	src := benchMetrics(benchBatchSize)
	for _, tc := range cases {
		b.Run(tc.name, func(b *testing.B) {
			p := newTestMetricsProcessor(b, tc.rules)
			ctx := context.Background()
			b.ReportAllocs()
			b.ResetTimer()
			for range b.N {
				b.StopTimer()
				md := pmetric.NewMetrics()
				src.CopyTo(md)
				b.StartTimer()
				if err := p.ConsumeMetrics(ctx, md); err != nil {
					b.Fatal(err)
				}
			}
			reportPerRecord(b)
		})
	}
}

// Matching must not allocate per record: a rule that evaluates every record
// but changes nothing costs the same allocations for 10 records as for 1,000.
// (Actions that rewrite data, such as DROP, REDACT and EXCLUDE_INDEX, do
// allocate per changed record; the benchmarks above track those.)
func TestMatchingAllocationsDoNotScaleWithBatchSize(t *testing.T) {
	if raceEnabled {
		t.Skip("allocation counts are meaningless under -race; CI runs this test without it")
	}
	ctx := context.Background()
	ignoreCase := func(r PolicyRule) PolicyRule { r.ConditionIgnoreCase = true; return r }
	check := func(signal string, consume func(small bool)) {
		t.Helper()
		small := testing.AllocsPerRun(20, func() { consume(true) })
		large := testing.AllocsPerRun(20, func() { consume(false) })
		if large != small {
			t.Errorf("%s: %v allocs for %d records but %v for 10: something on the per-record matching path allocates",
				signal, large, benchBatchSize, small)
		}
	}

	tp := newTestProcessor(t, []PolicyRule{
		benchRule("eq", SignalTraces, ActionDrop, "http.route", OpEquals, "/never"),
		benchRule("gt", SignalTraces, ActionDrop, "http.status_code", OpGreaterThan, "999"),
		ignoreCase(benchRule("contains", SignalTraces, ActionDrop, "user.email", OpContains, "NEVER")),
		benchRule("regex", SignalTraces, ActionRedact, "payment.card", OpRegexMatch, `^never$`),
		benchThrottleRule(SignalTraces),
	})
	smallTraces, largeTraces := benchTraces(10), benchTraces(benchBatchSize)
	check("traces", func(small bool) {
		td := largeTraces
		if small {
			td = smallTraces
		}
		if err := tp.ConsumeTraces(ctx, td); err != nil {
			t.Fatal(err)
		}
	})

	lp := newTestLogsProcessor(t, []PolicyRule{
		benchRule("severity-number", SignalLogs, ActionDrop, fieldLogSeverityNumber, OpLessThan, "1"),
		ignoreCase(benchRule("severity", SignalLogs, ActionDrop, fieldLogSeverity, OpEquals, "never")),
		benchRule("body", SignalLogs, ActionRedact, fieldLogBody, OpRegexMatch, `^never$`),
		benchThrottleRule(SignalLogs),
	})
	smallLogs, largeLogs := benchLogs(10), benchLogs(benchBatchSize)
	check("logs", func(small bool) {
		ld := largeLogs
		if small {
			ld = smallLogs
		}
		if err := lp.ConsumeLogs(ctx, ld); err != nil {
			t.Fatal(err)
		}
	})

	mp := newTestMetricsProcessor(t, []PolicyRule{
		benchRule("name", SignalMetrics, ActionDrop, fieldMetricName, OpRegexMatch, `^never\.`),
		benchThrottleRule(SignalMetrics),
	})
	smallMetrics, largeMetrics := benchMetrics(10), benchMetrics(benchBatchSize)
	check("metrics", func(small bool) {
		md := largeMetrics
		if small {
			md = smallMetrics
		}
		if err := mp.ConsumeMetrics(ctx, md); err != nil {
			t.Fatal(err)
		}
	})
}
