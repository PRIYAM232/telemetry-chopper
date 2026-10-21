package filterprocessor

import (
	"encoding/binary"
	"hash/maphash"
	"sync"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
)

// Distinct dropped metric series, per UTC hour. Vendors such as Datadog bill
// custom metrics by series (a metric name plus one combination of tag
// values), averaged over the hours of the month, not by bytes. Dropping
// datapoints of a series that still reaches the vendor saves nothing there;
// dropping every datapoint of a series saves that series. So the collector
// counts the distinct series its rules dropped in the current hour and
// reports the count with each heartbeat; the control plane takes the largest
// count per collector and hour.
//
// A series is identified by the metric name, the datapoint's attributes and
// the resource's host.name (the vendor's host tag). Other resource
// attributes are left out: vendors only turn some of them into tags, so
// leaving them out undercounts rather than overcounts.

// maxTrackedSeries caps the per-hour set so a cardinality explosion can't
// grow collector memory without bound. Past it, the hour's count stays at
// the cap: an undercount, never an overcount.
const maxTrackedSeries = 100_000

const attrHostName = "host.name"

type seriesTracker struct {
	mu   sync.Mutex
	seed maphash.Seed
	// hour is the Unix time of the start of the UTC hour seen holds.
	hour int64
	seen map[uint64]struct{}

	now func() time.Time
}

func newSeriesTracker() *seriesTracker {
	return &seriesTracker{seed: maphash.MakeSeed(), seen: make(map[uint64]struct{}), now: time.Now}
}

func hourStart(t time.Time) int64 {
	s := t.Unix()
	return s - s%3600
}

// rollLocked empties the set when the UTC hour has changed. clear keeps the
// map's buckets, so a steady drop rate doesn't reallocate every hour.
func (t *seriesTracker) rollLocked() {
	if h := hourStart(t.now()); h != t.hour {
		t.hour = h
		clear(t.seen)
	}
}

// observeDropped records every series of one dropped metric. Called only on
// the drop path, so batches the ruleset doesn't touch never pay for it.
func (t *seriesTracker) observeDropped(metric pmetric.Metric, host string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.rollLocked()
	name := metric.Name()
	eachDatapointAttributes(metric, func(attrs pcommon.Map) {
		if len(t.seen) >= maxTrackedSeries {
			return
		}
		t.seen[t.seriesKey(name, host, attrs)] = struct{}{}
	})
}

// snapshot returns the current hour and how many distinct series were
// dropped in it so far.
func (t *seriesTracker) snapshot() (hour int64, count int64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.rollLocked()
	return t.hour, int64(len(t.seen))
}

// seriesKey hashes a series identity. Attribute pairs are hashed one by one
// and summed, so the key doesn't depend on attribute order: vendors treat
// tags as a set.
func (t *seriesTracker) seriesKey(name, host string, attrs pcommon.Map) uint64 {
	var pair maphash.Hash
	pair.SetSeed(t.seed)
	var tags uint64
	addPair := func(k, v string) {
		pair.Reset()
		pair.WriteString(k)
		pair.WriteByte(0)
		pair.WriteString(v)
		tags += pair.Sum64()
	}
	attrs.Range(func(k string, v pcommon.Value) bool {
		addPair(k, v.AsString())
		return true
	})
	if host != "" {
		addPair("\x00host", host)
	}

	var h maphash.Hash
	h.SetSeed(t.seed)
	h.WriteString(name)
	h.WriteByte(0)
	var buf [8]byte
	binary.LittleEndian.PutUint64(buf[:], tags)
	h.Write(buf[:])
	return h.Sum64()
}

// eachDatapointAttributes calls fn with the attributes of every datapoint of
// the metric, whatever its type.
func eachDatapointAttributes(metric pmetric.Metric, fn func(pcommon.Map)) {
	switch metric.Type() {
	case pmetric.MetricTypeGauge:
		dps := metric.Gauge().DataPoints()
		for i := 0; i < dps.Len(); i++ {
			fn(dps.At(i).Attributes())
		}
	case pmetric.MetricTypeSum:
		dps := metric.Sum().DataPoints()
		for i := 0; i < dps.Len(); i++ {
			fn(dps.At(i).Attributes())
		}
	case pmetric.MetricTypeHistogram:
		dps := metric.Histogram().DataPoints()
		for i := 0; i < dps.Len(); i++ {
			fn(dps.At(i).Attributes())
		}
	case pmetric.MetricTypeExponentialHistogram:
		dps := metric.ExponentialHistogram().DataPoints()
		for i := 0; i < dps.Len(); i++ {
			fn(dps.At(i).Attributes())
		}
	case pmetric.MetricTypeSummary:
		dps := metric.Summary().DataPoints()
		for i := 0; i < dps.Len(); i++ {
			fn(dps.At(i).Attributes())
		}
	}
}

// resourceHost is the resource's host.name, or "" when it has none.
func resourceHost(resAttrs pcommon.Map) string {
	if v, ok := resAttrs.Get(attrHostName); ok {
		return v.AsString()
	}
	return ""
}
