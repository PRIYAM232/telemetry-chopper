package filterprocessor

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

const (
	// syncRequestTimeout bounds a single poll so a hung control plane can
	// never wedge the sync goroutine past one interval.
	syncRequestTimeout = 10 * time.Second

	// maxSyncResponseBytes caps how much policy JSON we will buffer. 4 MiB is
	// thousands of rules; anything larger is a control-plane bug, not a
	// bigger fleet.
	maxSyncResponseBytes = 4 << 20
)

// ruleEngine is the control-plane client shared by every signal processor
// created under one component ID: one rule cache, one policy poller, one
// stats heartbeat — regardless of how many pipelines reference the component.
// Without the sharing, a collector with both a traces and a logs pipeline
// would poll the policy endpoint twice and split its heartbeat in two.
//
// Concurrency model (unchanged from the Phase 2 traces-only design):
//   - One background goroutine (spawned by the first start, stopped by the
//     last stop) polls the control plane and REPLACES rules wholesale under
//     the write lock. Rules are never mutated in place after publication.
//   - A second background goroutine reports the atomic telemetry counters to
//     the control plane every stats interval and never touches the ruleset.
//   - Consume hot paths call snapshotRules, which holds the read lock only
//     long enough to copy the slice header; because published slices are
//     immutable, evaluation then runs lock-free on a consistent snapshot even
//     if a swap lands mid-batch.
type ruleEngine struct {
	cfg    *Config
	logger *zap.Logger

	httpClient *http.Client

	rulesMu       sync.RWMutex
	rules         []compiledRule // last known-good ruleset, evaluation-ready; nil until first successful sync
	lastRulesHash [sha256.Size]byte

	// lastETag is the ETag of the last policy response that parsed cleanly,
	// echoed back as If-None-Match so an unchanged control plane answers with
	// an empty 304 instead of the full ruleset. Only the sync goroutine reads
	// or writes it, so it lives outside rulesMu.
	lastETag string

	// Telemetry accounting since the last successful stats report, split per
	// signal. Plain atomics — not the rules lock — so the consume hot paths
	// never contend with the reporter.
	tracesReceived  atomic.Int64
	tracesDropped   atomic.Int64
	logsReceived    atomic.Int64
	logsDropped     atomic.Int64
	metricsReceived atomic.Int64
	metricsDropped  atomic.Int64

	// OTLP protobuf bytes of the records removed by the ruleset, per signal —
	// the volume the control plane prices against the fleet's vendor rate
	// card. Same drain/carry-over lifecycle as the counts above.
	tracesDroppedBytes  atomic.Int64
	logsDroppedBytes    atomic.Int64
	metricsDroppedBytes atomic.Int64

	// OTLP protobuf bytes of what the processor forwarded downstream — the
	// volume that still reaches the vendor and counts against the fleet's
	// committed tier. Same lifecycle as the dropped bytes.
	tracesForwardedBytes  atomic.Int64
	logsForwardedBytes    atomic.Int64
	metricsForwardedBytes atomic.Int64

	// Records forwarded with chopper.index = false by an EXCLUDE_INDEX rule:
	// still ingested by the vendor, but kept out of its paid index. Traces
	// and logs only — metrics aren't indexed events.
	tracesUnindexed atomic.Int64
	logsUnindexed   atomic.Int64

	// Per-rule match/drop counters (rulestats.go), carried across ruleset
	// swaps by rule ID and reported in the heartbeat's "rules" array.
	ruleStats ruleStatsRegistry

	// Self-metrics on the collector's own telemetry pipeline (see
	// telemetry.go). nil disables recording — engines built directly in tests
	// have no meter, and a failed instrument registration degrades to
	// heartbeat-only accounting rather than breaking the data plane.
	telemetry *engineTelemetry

	// Lifecycle of the background goroutines, refcounted across the signal
	// processors sharing this engine: the first start spawns them, the last
	// stop tears them down. cancelBackground is nil while not running (also
	// permanently, in static pass-through mode).
	lifecycleMu      sync.Mutex
	refs             int
	cancelBackground context.CancelFunc
	backgroundDone   sync.WaitGroup
}

func newRuleEngine(logger *zap.Logger, cfg *Config) *ruleEngine {
	return &ruleEngine{
		cfg:    cfg,
		logger: logger,
		httpClient: &http.Client{
			Timeout: syncRequestTimeout,
		},
	}
}

// adoptConfigIfIdle swaps in a freshly unmarshaled Config, but only while no
// processor holds the engine started. Engines outlive collector config
// reloads (the factory caches them by component ID), so without this a reload
// that edited an endpoint would keep polling the old one.
func (e *ruleEngine) adoptConfigIfIdle(cfg *Config) {
	e.lifecycleMu.Lock()
	defer e.lifecycleMu.Unlock()
	if e.refs == 0 {
		e.cfg = cfg
	}
}

// start registers one processor with the engine; the first registration
// spawns the control-plane goroutines. The collector's startup context is
// only valid for the duration of startup, so the goroutines get their own
// cancellable context tied to the last stop instead.
func (e *ruleEngine) start() {
	e.lifecycleMu.Lock()
	defer e.lifecycleMu.Unlock()

	e.refs++
	if e.refs > 1 {
		return
	}

	if e.cfg.SyncEndpoint == "" && e.cfg.StatsEndpoint == "" {
		e.logger.Info("chopper_filter started in static pass-through mode (no sync_endpoint/stats_endpoint configured)")
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	e.cancelBackground = cancel

	if e.cfg.SyncEndpoint != "" {
		e.backgroundDone.Add(1)
		go e.runSyncLoop(ctx)
		e.logger.Info("chopper_filter started with control-plane sync",
			zap.String("sync_endpoint", e.cfg.SyncEndpoint),
			zap.Duration("sync_interval", e.cfg.SyncInterval),
		)
	}
	if e.cfg.StatsEndpoint != "" {
		e.backgroundDone.Add(1)
		go e.runStatsLoop(ctx)
		e.logger.Info("chopper_filter started with control-plane stats reporting",
			zap.String("stats_endpoint", e.cfg.StatsEndpoint),
			zap.Duration("stats_interval", e.cfg.StatsInterval),
		)
	}
}

// stop deregisters one processor; the last deregistration signals the
// background goroutines to exit and blocks until they have. After the last
// stop returns, nothing touches the network or the rule cache. Tickers are
// released by each goroutine's own defer.
func (e *ruleEngine) stop() {
	e.lifecycleMu.Lock()
	defer e.lifecycleMu.Unlock()

	e.refs--
	if e.refs > 0 || e.cancelBackground == nil {
		return
	}
	e.cancelBackground()
	e.backgroundDone.Wait()
	e.cancelBackground = nil
}

// snapshotRules returns the current published ruleset. The returned slice is
// immutable by construction (syncOnce replaces, never mutates), so callers
// may evaluate it lock-free — pre-compiled REGEX_MATCH patterns included.
func (e *ruleEngine) snapshotRules() []compiledRule {
	e.rulesMu.RLock()
	defer e.rulesMu.RUnlock()
	return e.rules
}

// batchStats is one consumed batch's accounting. droppedBytes is the summed
// OTLP protobuf size of the removed records, forwardedBytes the size of the
// whole batch passed downstream (envelopes included, as the exporter will
// ship it), and unindexed the surviving records an EXCLUDE_INDEX rule opted
// out of indexing.
type batchStats struct {
	received       int64
	dropped        int64
	unindexed      int64
	droppedBytes   int64
	forwardedBytes int64
}

// observeTraces / observeLogs / observeMetrics record one consumed batch into
// BOTH accounting systems: the interval atomics drained by the stats
// heartbeat, and the cumulative self-metrics scraped from the collector's
// telemetry endpoint. Called on every batch from the consume hot paths — the
// atomic adds are contention-free and the counter adds are a single
// attribute-less instrument record.
//
// The byte volumes feed the heartbeat only; the self-metrics stay record
// counts.
func (e *ruleEngine) observeTraces(ctx context.Context, s batchStats) {
	e.tracesReceived.Add(s.received)
	e.tracesDropped.Add(s.dropped)
	e.tracesDroppedBytes.Add(s.droppedBytes)
	e.tracesForwardedBytes.Add(s.forwardedBytes)
	e.tracesUnindexed.Add(s.unindexed)
	if t := e.telemetry; t != nil {
		t.spansReceived.Add(ctx, s.received)
		t.spansDropped.Add(ctx, s.dropped)
	}
}

func (e *ruleEngine) observeLogs(ctx context.Context, s batchStats) {
	e.logsReceived.Add(s.received)
	e.logsDropped.Add(s.dropped)
	e.logsDroppedBytes.Add(s.droppedBytes)
	e.logsForwardedBytes.Add(s.forwardedBytes)
	e.logsUnindexed.Add(s.unindexed)
	if t := e.telemetry; t != nil {
		t.logsReceived.Add(ctx, s.received)
		t.logsDropped.Add(ctx, s.dropped)
	}
}

func (e *ruleEngine) observeMetrics(ctx context.Context, s batchStats) {
	e.metricsReceived.Add(s.received)
	e.metricsDropped.Add(s.dropped)
	e.metricsDroppedBytes.Add(s.droppedBytes)
	e.metricsForwardedBytes.Add(s.forwardedBytes)
	if t := e.telemetry; t != nil {
		t.metricsReceived.Add(ctx, s.received)
		t.metricsDropped.Add(ctx, s.dropped)
	}
}

// --- Control-plane sync -------------------------------------------------------

// runSyncLoop polls immediately on startup (so a fresh collector enforces
// policy within seconds, not one full interval), then on every tick until the
// context is cancelled by the last stop.
func (e *ruleEngine) runSyncLoop(ctx context.Context) {
	defer e.backgroundDone.Done()

	ticker := time.NewTicker(e.cfg.SyncInterval)
	defer ticker.Stop()

	e.syncOnce(ctx)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			e.syncOnce(ctx)
		}
	}
}

// syncOnce performs one authenticated poll of the control plane and, on
// success, atomically publishes the new ruleset. Any failure leaves the last
// known-good ruleset in place — a flaky control plane degrades to slightly
// stale policy, never to an open pipeline with no policy at all.
func (e *ruleEngine) syncOnce(ctx context.Context) {
	reqCtx, cancel := context.WithTimeout(ctx, syncRequestTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, e.cfg.SyncEndpoint, nil)
	if err != nil {
		e.logger.Error("chopper_filter policy sync: building request failed", zap.Error(err))
		return
	}
	req.Header.Set("Authorization", "Bearer "+string(e.cfg.FleetKey))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "otelcol-chopper/chopper_filter")
	if e.lastETag != "" {
		req.Header.Set("If-None-Match", e.lastETag)
	}

	resp, err := e.httpClient.Do(req)
	if err != nil {
		// Includes cancellation during Shutdown; ctx.Err() distinguishes it.
		if ctx.Err() == nil {
			e.logger.Warn("chopper_filter policy sync: request failed, keeping last known-good rules", zap.Error(err))
		}
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotModified {
		// The control plane confirmed our ruleset is current: no payload to
		// parse, no lock to take — the cheapest possible poll.
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		e.logger.Debug("chopper_filter policy sync: not modified (304), ruleset current")
		return
	}

	if resp.StatusCode != http.StatusOK {
		// Drain a little so the connection can be reused, then bail.
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		e.logger.Warn("chopper_filter policy sync: unexpected status, keeping last known-good rules",
			zap.Int("status", resp.StatusCode),
		)
		return
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxSyncResponseBytes+1))
	if err != nil {
		e.logger.Warn("chopper_filter policy sync: reading body failed", zap.Error(err))
		return
	}
	if len(body) > maxSyncResponseBytes {
		e.logger.Warn("chopper_filter policy sync: response exceeds size cap, keeping last known-good rules",
			zap.Int("cap_bytes", maxSyncResponseBytes),
		)
		return
	}

	var payload FleetPolicyResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		e.logger.Warn("chopper_filter policy sync: invalid JSON payload", zap.Error(err))
		return
	}

	// Adopt the ETag only now that the payload has proven parseable: caching
	// the tag of a body we rejected would make the control plane 304 us into
	// never re-fetching a corrected one. An absent header clears the cache,
	// which degrades cleanly to unconditional polling.
	e.lastETag = resp.Header.Get("ETag")

	hash := sha256.Sum256(body)

	e.rulesMu.Lock()
	changed := hash != e.lastRulesHash
	e.rulesMu.Unlock()
	if !changed {
		e.logger.Debug("chopper_filter policy sync: ruleset unchanged")
		return
	}

	// Compile OUTSIDE the write lock: regexp.Compile is the expensive step
	// this design exists to keep away from the hot paths, and holding rulesMu
	// through it would stall every consumer on snapshotRules meanwhile.
	compiled := compileRules(payload.Rules, e.logger)
	// Hand each rule its long-lived counters before anything can evaluate
	// against the new slice.
	e.ruleStats.adopt(compiled)

	e.rulesMu.Lock()
	e.rules = compiled
	e.lastRulesHash = hash
	e.rulesMu.Unlock()

	enforcedTraces, enforcedLogs, enforcedMetrics := 0, 0, 0
	for i := range compiled {
		if ruleAppliesTraces(&compiled[i]) {
			enforcedTraces++
		}
		if ruleAppliesLogs(&compiled[i]) {
			enforcedLogs++
		}
		if ruleAppliesMetrics(&compiled[i]) {
			enforcedMetrics++
		}
	}
	e.logger.Info("chopper_filter policy sync: ruleset updated",
		zap.String("fleet_id", payload.FleetID),
		zap.Int("rules_total", len(compiled)),
		zap.Int("rules_enforced_traces", enforcedTraces),
		zap.Int("rules_enforced_logs", enforcedLogs),
		zap.Int("rules_enforced_metrics", enforcedMetrics),
		zap.Int("rules_ignored", len(compiled)-enforcedTraces-enforcedLogs-enforcedMetrics),
	)
}

// --- Stats reporting -----------------------------------------------------------

// statsPayload is the wire format of POST /api/v1/telemetry/:fleetId/stats.
// Mirrored by the route handler in
// control-plane/src/app/api/v1/telemetry/[fleetId]/stats/route.ts.
//
// Forward compatibility is free here: a pre-Phase-6 control plane simply
// ignores the metrics_* keys it doesn't parse and still stores the trace/log
// counts, so collectors can upgrade before their control plane without the
// heartbeat degrading. The *_dropped_bytes, *_forwarded_bytes and
// *_unindexed keys get the same treatment.
//
// Dropped bytes are the OTLP protobuf size of each removed span / log record
// / metric, excluding the resource and scope envelopes they shared with
// surviving records — a slight undercount of the wire volume, never an
// overcount. Forwarded bytes are the size of each whole batch passed
// downstream, envelopes included: the volume still billed by the vendor.
type statsPayload struct {
	TracesReceived  int64 `json:"traces_received"`
	TracesDropped   int64 `json:"traces_dropped"`
	LogsReceived    int64 `json:"logs_received"`
	LogsDropped     int64 `json:"logs_dropped"`
	MetricsReceived int64 `json:"metrics_received"`
	MetricsDropped  int64 `json:"metrics_dropped"`

	TracesDroppedBytes  int64 `json:"traces_dropped_bytes"`
	LogsDroppedBytes    int64 `json:"logs_dropped_bytes"`
	MetricsDroppedBytes int64 `json:"metrics_dropped_bytes"`

	TracesForwardedBytes  int64 `json:"traces_forwarded_bytes"`
	LogsForwardedBytes    int64 `json:"logs_forwarded_bytes"`
	MetricsForwardedBytes int64 `json:"metrics_forwarded_bytes"`

	// Records forwarded but opted out of the vendor's index by EXCLUDE_INDEX.
	TracesUnindexed int64 `json:"traces_unindexed"`
	LogsUnindexed   int64 `json:"logs_unindexed"`

	// Per-rule attribution of the totals above (issue #14): only rules with
	// activity this interval, so idle rules cost nothing on the wire. A
	// control plane that predates it ignores the key.
	Rules []ruleStatsPayload `json:"rules,omitempty"`
}

// runStatsLoop reports immediately on startup — an all-zero report is the
// "collector online" heartbeat — then on every tick until the context is
// cancelled by the last stop.
func (e *ruleEngine) runStatsLoop(ctx context.Context) {
	defer e.backgroundDone.Done()

	ticker := time.NewTicker(e.cfg.StatsInterval)
	defer ticker.Stop()

	e.reportStatsOnce(ctx)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			e.reportStatsOnce(ctx)
		}
	}
}

// reportStatsOnce drains the counters and POSTs them as one interval delta.
// Counters are zeroed by the drain and folded back in if the POST fails, so
// they only ever reset on a successful transmit — a control-plane outage
// accumulates into the next report instead of losing counts.
//
// The Swaps are not one atomic snapshot: a batch landing between them can
// make this interval's dropped count exceed its received count (the batch's
// received half rides along in the next report). Sums across reports are
// exact, which is all the dashboard aggregates.
func (e *ruleEngine) reportStatsOnce(ctx context.Context) {
	stats := statsPayload{
		TracesReceived:  e.tracesReceived.Swap(0),
		TracesDropped:   e.tracesDropped.Swap(0),
		LogsReceived:    e.logsReceived.Swap(0),
		LogsDropped:     e.logsDropped.Swap(0),
		MetricsReceived: e.metricsReceived.Swap(0),
		MetricsDropped:  e.metricsDropped.Swap(0),

		TracesDroppedBytes:  e.tracesDroppedBytes.Swap(0),
		LogsDroppedBytes:    e.logsDroppedBytes.Swap(0),
		MetricsDroppedBytes: e.metricsDroppedBytes.Swap(0),

		TracesForwardedBytes:  e.tracesForwardedBytes.Swap(0),
		LogsForwardedBytes:    e.logsForwardedBytes.Swap(0),
		MetricsForwardedBytes: e.metricsForwardedBytes.Swap(0),

		TracesUnindexed: e.tracesUnindexed.Swap(0),
		LogsUnindexed:   e.logsUnindexed.Swap(0),

		Rules: e.ruleStats.drain(),
	}

	if err := e.postStats(ctx, stats); err != nil {
		e.tracesReceived.Add(stats.TracesReceived)
		e.tracesDropped.Add(stats.TracesDropped)
		e.logsReceived.Add(stats.LogsReceived)
		e.logsDropped.Add(stats.LogsDropped)
		e.metricsReceived.Add(stats.MetricsReceived)
		e.metricsDropped.Add(stats.MetricsDropped)
		e.tracesDroppedBytes.Add(stats.TracesDroppedBytes)
		e.logsDroppedBytes.Add(stats.LogsDroppedBytes)
		e.metricsDroppedBytes.Add(stats.MetricsDroppedBytes)
		e.tracesForwardedBytes.Add(stats.TracesForwardedBytes)
		e.logsForwardedBytes.Add(stats.LogsForwardedBytes)
		e.metricsForwardedBytes.Add(stats.MetricsForwardedBytes)
		e.tracesUnindexed.Add(stats.TracesUnindexed)
		e.logsUnindexed.Add(stats.LogsUnindexed)
		e.ruleStats.restore(stats.Rules)
		if ctx.Err() == nil {
			e.logger.Warn("chopper_filter stats report failed, counts carry over to next interval",
				zap.Int64("traces_received", stats.TracesReceived),
				zap.Int64("traces_dropped", stats.TracesDropped),
				zap.Int64("logs_received", stats.LogsReceived),
				zap.Int64("logs_dropped", stats.LogsDropped),
				zap.Int64("metrics_received", stats.MetricsReceived),
				zap.Int64("metrics_dropped", stats.MetricsDropped),
				zap.Int64("traces_dropped_bytes", stats.TracesDroppedBytes),
				zap.Int64("logs_dropped_bytes", stats.LogsDroppedBytes),
				zap.Int64("metrics_dropped_bytes", stats.MetricsDroppedBytes),
				zap.Int64("traces_forwarded_bytes", stats.TracesForwardedBytes),
				zap.Int64("logs_forwarded_bytes", stats.LogsForwardedBytes),
				zap.Int64("metrics_forwarded_bytes", stats.MetricsForwardedBytes),
				zap.Int64("traces_unindexed", stats.TracesUnindexed),
				zap.Int64("logs_unindexed", stats.LogsUnindexed),
				zap.Error(err),
			)
		}
		return
	}
	e.ruleStats.forgetRetired()

	e.logger.Debug("chopper_filter stats reported",
		zap.Int64("traces_received", stats.TracesReceived),
		zap.Int64("traces_dropped", stats.TracesDropped),
		zap.Int64("logs_received", stats.LogsReceived),
		zap.Int64("logs_dropped", stats.LogsDropped),
		zap.Int64("metrics_received", stats.MetricsReceived),
		zap.Int64("metrics_dropped", stats.MetricsDropped),
		zap.Int64("traces_dropped_bytes", stats.TracesDroppedBytes),
		zap.Int64("logs_dropped_bytes", stats.LogsDroppedBytes),
		zap.Int64("metrics_dropped_bytes", stats.MetricsDroppedBytes),
		zap.Int64("traces_forwarded_bytes", stats.TracesForwardedBytes),
		zap.Int64("logs_forwarded_bytes", stats.LogsForwardedBytes),
		zap.Int64("metrics_forwarded_bytes", stats.MetricsForwardedBytes),
		zap.Int64("traces_unindexed", stats.TracesUnindexed),
		zap.Int64("logs_unindexed", stats.LogsUnindexed),
		zap.Int("rules_reported", len(stats.Rules)),
	)
}

// postStats performs one authenticated POST to the stats endpoint, under the
// same timeout and auth rules as the policy pull.
func (e *ruleEngine) postStats(ctx context.Context, stats statsPayload) error {
	body, err := json.Marshal(stats)
	if err != nil {
		return err
	}

	reqCtx, cancel := context.WithTimeout(ctx, syncRequestTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, e.cfg.StatsEndpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+string(e.cfg.FleetKey))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "otelcol-chopper/chopper_filter")

	resp, err := e.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	// Drain a little so the connection can be reused.
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("stats endpoint returned status %d", resp.StatusCode)
	}
	return nil
}
