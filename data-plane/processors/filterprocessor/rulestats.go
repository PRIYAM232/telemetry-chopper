package filterprocessor

import (
	"sync"
	"sync/atomic"
)

// Per-rule accounting (issue #14). The fleet-wide counters in engine.go say
// how much was dropped; these say which rule did it, so an operator can tell
// a rule that matches nothing (a typo'd condition field) from one doing the
// heavy lifting, or a THROTTLE that is clamping from a tenant gone quiet.
//
// Every compiledRule carries a pointer to its ruleCounters, so the consume
// hot paths pay one uncontended atomic add per counted event: no map lookup,
// no allocation, no lock. The engine keeps the counters in a map keyed by
// rule ID and hands the SAME counters to every recompiled ruleset, so a sync
// landing mid-interval neither loses pending counts nor resets the
// cumulative self-metrics. Rules are immutable apart from isActive, so the
// identity fields captured at first sight stay accurate.

// ruleCounters is one rule's tally. Interval counts are drained by the stats
// heartbeat (same drain/carry-over lifecycle as the fleet counters);
// cumulative counts are never reset and back the Prometheus self-metrics,
// which expect monotonic counters.
type ruleCounters struct {
	id     string
	name   string
	signal string
	action string

	// Interval counts since the last successful heartbeat.
	matched      atomic.Int64 // records whose condition this rule evaluated and matched
	dropped      atomic.Int64 // records this rule removed (DROP, unsampled SAMPLE, THROTTLE excess)
	droppedBytes atomic.Int64 // OTLP protobuf bytes of those records
	unindexed    atomic.Int64 // records this EXCLUDE_INDEX rule opted out of indexing that were forwarded

	// Cumulative since process start, for the self-metrics.
	totalMatched atomic.Int64
	totalDropped atomic.Int64
}

func newRuleCounters(r *PolicyRule) *ruleCounters {
	return &ruleCounters{id: r.ID, name: r.Name, signal: r.TargetSignal, action: r.ActionType}
}

// countMatch records one record whose condition this rule matched. Rules are
// evaluated in order and a dropping rule ends evaluation, so a record removed
// by an earlier rule is never counted as a match for later ones.
func (c *ruleCounters) countMatch() {
	c.matched.Add(1)
	c.totalMatched.Add(1)
}

// countDrop records one record this rule removed and its size.
func (c *ruleCounters) countDrop(bytes int64) {
	c.dropped.Add(1)
	c.droppedBytes.Add(bytes)
	c.totalDropped.Add(1)
}

// ruleStatsPayload is one rule's entry in the heartbeat's "rules" array.
// Mirrored by the stats route handler in the control plane.
type ruleStatsPayload struct {
	RuleID       string `json:"rule_id"`
	Matched      int64  `json:"matched"`
	Dropped      int64  `json:"dropped"`
	DroppedBytes int64  `json:"dropped_bytes"`
	Unindexed    int64  `json:"unindexed"`
}

// ruleStatsRegistry owns every rule's counters across ruleset swaps.
type ruleStatsRegistry struct {
	mu   sync.Mutex
	byID map[string]*ruleCounters
	// retired holds counters of rules dropped from the ruleset that may still
	// carry undrained interval counts; the next successful heartbeat reports
	// them one last time and forgets them.
	retired map[string]*ruleCounters
}

// adopt points every freshly compiled rule at its long-lived counters,
// creating them for rules seen for the first time, and retires the counters
// of rules no longer in the ruleset. Runs once per successful sync, before
// the ruleset is published.
func (r *ruleStatsRegistry) adopt(compiled []compiledRule) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.byID == nil {
		r.byID = make(map[string]*ruleCounters, len(compiled))
	}
	next := make(map[string]*ruleCounters, len(compiled))
	for i := range compiled {
		id := compiled[i].ID
		c, ok := r.byID[id]
		if !ok {
			if c, ok = r.retired[id]; ok {
				delete(r.retired, id)
			} else {
				c = compiled[i].stats
			}
		}
		compiled[i].stats = c
		next[id] = c
	}
	for id, c := range r.byID {
		if _, kept := next[id]; !kept {
			if r.retired == nil {
				r.retired = make(map[string]*ruleCounters)
			}
			r.retired[id] = c
		}
	}
	r.byID = next
}

// drain swaps every rule's interval counts to zero and returns the non-zero
// ones. Rules with no activity this interval are left out, so the heartbeat
// stays small however many rules are idle.
func (r *ruleStatsRegistry) drain() []ruleStatsPayload {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []ruleStatsPayload
	collect := func(c *ruleCounters) {
		p := ruleStatsPayload{
			RuleID:       c.id,
			Matched:      c.matched.Swap(0),
			Dropped:      c.dropped.Swap(0),
			DroppedBytes: c.droppedBytes.Swap(0),
			Unindexed:    c.unindexed.Swap(0),
		}
		if p.Matched != 0 || p.Dropped != 0 || p.DroppedBytes != 0 || p.Unindexed != 0 {
			out = append(out, p)
		}
	}
	for _, c := range r.byID {
		collect(c)
	}
	for _, c := range r.retired {
		collect(c)
	}
	return out
}

// restore folds a failed heartbeat's per-rule counts back in, so they ride
// along with the next report — counts only reset on a successful transmit.
func (r *ruleStatsRegistry) restore(entries []ruleStatsPayload) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, p := range entries {
		c, ok := r.byID[p.RuleID]
		if !ok {
			if c, ok = r.retired[p.RuleID]; !ok {
				continue
			}
		}
		c.matched.Add(p.Matched)
		c.dropped.Add(p.Dropped)
		c.droppedBytes.Add(p.DroppedBytes)
		c.unindexed.Add(p.Unindexed)
	}
}

// forgetRetired drops retired counters once a heartbeat carrying their final
// counts has been accepted. A batch still evaluating against the old
// ruleset snapshot could add to them after the drain; those last few counts
// are lost with the deleted rule, which is acceptable.
func (r *ruleStatsRegistry) forgetRetired() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.retired = nil
}

// each calls fn for every rule in the current ruleset, for the self-metrics
// callback. Retired rules stop being reported, so their series go stale.
func (r *ruleStatsRegistry) each(fn func(*ruleCounters)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, c := range r.byID {
		fn(c)
	}
}
