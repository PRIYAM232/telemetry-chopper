# Feature 6: Per-rule match and drop counts

**Status:** Shipped, 2026-10-01 · **PR:** _pending_ · **Issue:** [#14](https://github.com/PRIYAM232/telemetry-chopper/issues/14)

## Summary

Every count used to be fleet-wide, so there was no way to tell which rule was doing the work:
- a rule with a typo'd condition field looked the same as a correct rule that simply had no matching traffic;
- a THROTTLE that was clamping looked the same as a tenant that had gone quiet.

The collector now counts, for each rule, the records it **matched**, **dropped** (with their bytes), and **kept out of the index**. Each rule card on the dashboard shows these counts for the selected time range. Prometheus gets the same counts with a `rule_id` / `rule_name` label.

## Using it

Each rule card shows a counts line for the dashboard's time range (1h / 24h / 7d / All time):

| Action | Shows |
|---|---|
| DROP | matched · dropped · bytes · share of fleet drops · saves $ |
| SAMPLE | as DROP, plus the share of matches sampled out |
| THROTTLE | as DROP, plus the share of matches over the limit (0% means the limit isn't biting) |
| EXCLUDE_INDEX | matched · kept out of the index · saves $ (indexing) |
| REDACT, ROUTE | matched |

An amber **no matches in the last 24 hours** chip (or **no matches yet** under All time) flags a rule whose condition never matched, even though its signal had traffic in the window. Check that the condition field is spelled the way your telemetry spells it. The chip only appears for active, enforced rules more than a minute old, so a newly created rule isn't flagged before its first heartbeat.

The **saves** figure uses the same rate card, indexing prices and cloud egress settings as the headline, so the rules' figures add up to the headline total.

Until a fleet's collectors report per-rule counts (collectors that predate this feature), the Policy rules header says so and the cards show no counts.

### Prometheus

The collector's self-metrics endpoint (`:8888`) adds two counters, one series per synced rule:

| Metric | Meaning |
|---|---|
| `otelcol_chopper_filter_rule_matched{rule_id, rule_name, signal, action}` | records whose condition the rule matched |
| `otelcol_chopper_filter_rule_dropped{rule_id, rule_name, signal, action}` | records the rule removed |

The Helm chart's Grafana dashboard gains **Dropped by rule /s (top 10)** and **Rules matching nothing (1h)**. Alert on silent rules with:

```promql
sum by (rule_id, rule_name) (increase(otelcol_chopper_filter_rule_matched[1h])) == 0
```

## How it's counted

- **Matched:** the rule's condition matched a record it evaluated. Rules run in order and a drop ends evaluation, so a record dropped by an earlier rule isn't counted against later ones. Two DROP rules matching the same record credit the first one.
- **Dropped / bytes:** credited to the rule that removed the record. Bytes are the OTLP protobuf size, the same measure as the fleet's dropped bytes. Per-rule sums equal the fleet totals.
- **Kept out of the index:** credited to the first EXCLUDE_INDEX rule that stamped a record that was then forwarded. A record stamped and later dropped counts as dropped, as at fleet level.
- **Share of fleet drops:** the rule's drops ÷ all drops in the window, across signals.

## What changed

**Data plane** (`data-plane/processors/filterprocessor/`)

| File | Change |
|---|---|
| `rulestats.go` (new) | `ruleCounters` (interval + cumulative atomics) and a registry keyed by rule ID: counters survive ruleset swaps, a removed rule is reported one last time, then forgotten |
| `rules.go` | `compiledRule.stats` pointer, so the hot path is one atomic add per counted event, with no map lookup or allocation |
| `processor.go`, `logs.go`, `metrics.go` | Evaluators return the dropping rule and the first EXCLUDE_INDEX rule instead of booleans; matches are counted per rule |
| `engine.go` | Heartbeat gains `rules: [{rule_id, matched, dropped, dropped_bytes, unindexed}]` (active rules only, omitted when none), with the same drain and carry-over on failure |
| `telemetry.go`, `factory.go` | Observable counters `rule_matched` / `rule_dropped`, read at scrape time from cumulative atomics |

**Control plane**

| File | Change |
|---|---|
| `prisma/schema.prisma` + migration `20261001001917_per_rule_metrics` | `RuleMetric` (fleet, rule, matched, dropped, droppedBytes, unindexed, createdAt); cascades with its rule; indexed `(fleetId, createdAt)` |
| `src/app/api/v1/telemetry/[fleetId]/stats/route.ts` | Parses `rules`; 400 on malformed entries; skips IDs the fleet doesn't own (deleted rules, other fleets, bad UUIDs); one transaction with the FleetMetric row |
| `src/lib/rule-stats.ts` (new) | Windowed per-rule sums; per-rule savings priced like the headline |
| `src/app/dashboard/page.tsx` | Counts line and "no matches" chip on each rule card |

**Helm:** two Grafana panels and the README metrics table.

## Upgrading and compatibility

- Old collectors keep working with a new control plane: no `rules` key means no per-rule rows, and the dashboard says per-rule counts need an updated collector.
- New collectors work with an old control plane, which ignores the key.
- Per-rule history starts when collectors are upgraded; earlier traffic is not attributed.

## Limitations

- Counts are per record evaluated, not per unique trace or log stream.
- If a rule is deleted while a collector still holds it, the counts from batches that were mid-evaluation against the old ruleset are lost, along with the rule's history.
- The "no matches" chip compares against the rule's signal traffic for the whole fleet. A rule scoped to one service that has gone quiet is flagged too, which is usually what you want to know.

## Verification

- **Unit tests** (`rulestats_test.go`, race detector on): per-rule matched, dropped, bytes and unindexed for traces, logs and metrics; a typo'd field reports zero; first drop wins; THROTTLE matched > dropped > 0; the heartbeat carries counts, survives a resync, carries over on failure, reports a removed rule once, then forgets it.
- **Benchmark:** 512 spans, 3 rules: 39.3 → 40.0 µs per batch (+1.8%), 0 added allocations.
- **Full stack:** collector built from the branch in an isolated compose project. 7 rules, including a typo'd field, a span matched by two DROP rules, and EXCLUDE_INDEX before DROP. Each payload was sent 50 times. Every rule's database totals matched an independent pdata byte oracle exactly:

  | Rule | Matched | Dropped | Bytes | Unindexed |
  |---|---|---|---|---|
  | drop-404-spans | 250 | 250 | 28,700 (574 × 50) | 0 |
  | drop-healthcheck-noise | 150 | 150 | 17,100 (342 × 50) | 0 |
  | unindex-heartbeats | 150 | 0 | 0 | 100 |
  | drop-debug-logs | 150 | 150 | 7,750 (155 × 50) | 0 |
  | drop-noisy-gauge | 50 | 50 | 1,950 (39 × 50) | 0 |
  | typo-drop-500s, sample-checkout-service | no rows | | | |

  Per-rule sums equalled the fleet totals for every signal. The Prometheus counters showed the same numbers, with explicit 0 series for the two silent rules.
- **Heartbeat route:** malformed `rules` → 400; negative count → 400; unknown IDs, bad UUIDs and another fleet's rule → skipped with 204; no `rules` key → 204.
- **Dashboard** (browser): the counts line, share and savings on each card. With ingest, indexing and egress priced, the per-rule savings summed to $9.08725 against a $9.09 headline. The silent-rule chip appeared on the two silent rules, a 2-day-old row appeared under 7d but not 24h, the All time wording was right, and the share is clamped to 100%. Checked in light and dark mode at phone and desktop widths, with no horizontal scroll.
- **Grafana queries** validated with `promtool check rules`.

## History

- 2026-10-01: shipped (issue #14).
