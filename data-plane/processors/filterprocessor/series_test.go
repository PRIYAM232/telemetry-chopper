package filterprocessor

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.uber.org/zap"
)

// gaugeWithSeries is one gauge metric with a datapoint per attribute set.
func gaugeWithSeries(ms pmetric.MetricSlice, name string, attrSets ...map[string]string) {
	m := ms.AppendEmpty()
	m.SetName(name)
	dps := m.SetEmptyGauge().DataPoints()
	for _, set := range attrSets {
		dp := dps.AppendEmpty()
		dp.SetIntValue(1)
		for k, v := range set {
			dp.Attributes().PutStr(k, v)
		}
	}
}

func fixedClock(t time.Time) func() time.Time { return func() time.Time { return t } }

func TestSeriesTrackerCountsDistinctSeries(t *testing.T) {
	tr := newSeriesTracker()
	tr.now = fixedClock(time.Date(2026, 10, 20, 9, 15, 0, 0, time.UTC))

	ms := pmetric.NewMetricSlice()
	gaugeWithSeries(ms, "queue.depth",
		map[string]string{"queue": "a", "env": "prod"},
		map[string]string{"queue": "b", "env": "prod"},
	)
	// Same series as the first datapoint above, attributes in another order.
	m := ms.AppendEmpty()
	m.SetName("queue.depth")
	dp := m.SetEmptyGauge().DataPoints().AppendEmpty()
	dp.Attributes().PutStr("env", "prod")
	dp.Attributes().PutStr("queue", "a")
	// Same attributes, other metric name: a different series.
	gaugeWithSeries(ms, "queue.age", map[string]string{"queue": "a", "env": "prod"})

	for i := 0; i < ms.Len(); i++ {
		tr.observeDropped(ms.At(i), "host-1")
	}
	// The same series again, and from another host.
	tr.observeDropped(ms.At(0), "host-1")
	tr.observeDropped(ms.At(2), "host-2")

	hour, n := tr.snapshot()
	if want := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC).Unix(); hour != want {
		t.Errorf("hour = %d, want %d", hour, want)
	}
	// queue.depth{a}, queue.depth{b}, queue.age{a}@host-1, queue.age{a}@host-2.
	if n != 4 {
		t.Errorf("distinct series = %d, want 4", n)
	}
}

func TestSeriesTrackerResetsEachHour(t *testing.T) {
	tr := newSeriesTracker()
	now := time.Date(2026, 10, 20, 9, 59, 50, 0, time.UTC)
	tr.now = func() time.Time { return now }

	ms := pmetric.NewMetricSlice()
	gaugeWithSeries(ms, "cpu", map[string]string{"core": "0"}, map[string]string{"core": "1"})
	tr.observeDropped(ms.At(0), "")
	if _, n := tr.snapshot(); n != 2 {
		t.Fatalf("before rollover: %d series, want 2", n)
	}

	now = now.Add(20 * time.Second)
	hour, n := tr.snapshot()
	if n != 0 || hour != time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC).Unix() {
		t.Fatalf("after rollover: hour %d, %d series; want 10:00 and 0", hour, n)
	}
	tr.observeDropped(ms.At(0), "")
	if _, n := tr.snapshot(); n != 2 {
		t.Errorf("new hour: %d series, want 2", n)
	}
}

func TestSeriesTrackerCapsTheHour(t *testing.T) {
	tr := newSeriesTracker()
	m := pmetric.NewMetric()
	m.SetName("ids")
	dps := m.SetEmptyGauge().DataPoints()
	for i := 0; i < maxTrackedSeries+50; i++ {
		dps.AppendEmpty().Attributes().PutInt("id", int64(i))
	}
	tr.observeDropped(m, "")
	if _, n := tr.snapshot(); n != maxTrackedSeries {
		t.Errorf("series = %d, want the cap %d", n, maxTrackedSeries)
	}
}

// Only metrics a rule drops are counted, and a series dropped in every batch
// counts once per hour.
func TestDroppedMetricsCountSeriesOncePerHour(t *testing.T) {
	p := newTestMetricsProcessor(t, []PolicyRule{
		dropMetricsRule("drop debug", fieldMetricName, OpEquals, "debug.queue"),
	})
	batch := func() pmetric.Metrics {
		md := pmetric.NewMetrics()
		rm := md.ResourceMetrics().AppendEmpty()
		rm.Resource().Attributes().PutStr(attrHostName, "node-7")
		ms := rm.ScopeMetrics().AppendEmpty().Metrics()
		gaugeWithSeries(ms, "debug.queue", map[string]string{"q": "a"}, map[string]string{"q": "b"}, map[string]string{"q": "c"})
		gaugeWithSeries(ms, "http.requests", map[string]string{"route": "/"})
		return md
	}
	for range 3 {
		if err := p.ConsumeMetrics(context.Background(), batch()); err != nil {
			t.Fatal(err)
		}
	}
	if _, n := p.engine.droppedSeries.snapshot(); n != 3 {
		t.Errorf("dropped series = %d, want 3 (http.requests survived)", n)
	}
}

func TestHeartbeatReportsDroppedSeries(t *testing.T) {
	var bodies []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Errorf("heartbeat isn't JSON: %v", err)
		}
		bodies = append(bodies, body)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	e := newRuleEngine(zap.NewNop(), &Config{StatsEndpoint: srv.URL, FleetKey: "k", StatsInterval: 10 * time.Second})
	now := time.Date(2026, 10, 20, 9, 30, 0, 0, time.UTC)
	e.droppedSeries.now = fixedClock(now)

	e.reportStatsOnce(context.Background())
	ms := pmetric.NewMetricSlice()
	gaugeWithSeries(ms, "debug.queue", map[string]string{"q": "a"}, map[string]string{"q": "b"})
	e.droppedSeries.observeDropped(ms.At(0), "")
	e.reportStatsOnce(context.Background())
	// Still the same hour: the running count is reported again, unchanged.
	e.reportStatsOnce(context.Background())

	if len(bodies) != 3 {
		t.Fatalf("got %d heartbeats, want 3", len(bodies))
	}
	if _, ok := bodies[0]["metrics_dropped_series"]; ok {
		t.Errorf("heartbeat with nothing dropped carries metrics_dropped_series: %v", bodies[0])
	}
	wantHour := float64(time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC).Unix())
	for _, b := range bodies[1:] {
		if b["metrics_dropped_series"] != float64(2) || b["metrics_series_hour"] != wantHour {
			t.Errorf("heartbeat = %v, want metrics_dropped_series 2 for hour %v", b, wantHour)
		}
	}
}
