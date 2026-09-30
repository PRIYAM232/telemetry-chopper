# Feature 3: Split-metric pricing (ingest vs. indexing)

**Status:** Shipped, 2026-09-30 · **PR:** [#35](https://github.com/PRIYAM232/telemetry-chopper/pull/35)

## Summary

Some vendors bill telemetry twice: once to **ingest** it (per GB) and again to **index** it for search (per million events). Datadog, for example, charges about $0.10/GB to ingest logs and about $1.70 per million to index them. This feature adds per-million indexing prices to the rate card and splits every saved dollar by what it pays for:

| What happens to a record | Ingest saved | Indexing saved |
|---|---|---|
| **Dropped in the collector** (DROP, unsampled SAMPLE, THROTTLE excess) | ✓ its bytes × $/GB | ✓ 1 event × $/million |
| **Forwarded but excluded from the index** (new **EXCLUDE_INDEX** action) | ✗ still ingested | ✓ 1 event × $/million |
| Forwarded normally (REDACT, ROUTE, no match) | ✗ | ✗ |

A new **Savings breakdown** widget on the dashboard shows ingest savings against indexing savings.

> **Why SAMPLE saves both.** In Telemetry Chopper, SAMPLE runs *in the collector*: sampled-out spans are removed before they reach the vendor, so they save ingest as well as indexing, exactly like DROP. The indexing-only case is data you still send (for live tail, metrics-from-logs or archives) but don't pay to make searchable. That case is the new EXCLUDE_INDEX action.

## Using it

**1. Add your indexing prices.** On `/settings/pricing`, under **Indexing price, USD per million events**, enter prices for **indexed log events** and **indexed spans** (for example `1.70`). Leave them at `0` if your vendor doesn't bill indexing separately. Metrics have no field, because they aren't indexed events.

**2. Optionally, exclude data from the index.** Create a rule with action **EXCLUDE_INDEX**, on TRACES or LOGS only; the form rejects METRICS. For example: LOGS where `log.severity EQUALS INFO`. Matching records keep flowing, stamped with the record attribute `chopper.index = false`.

**3. Tell your vendor to skip them.** Add an index exclusion or retention filter on that attribute, for example `@chopper.index:false` in a Datadog log index exclusion filter. Without that filter the vendor still indexes the records, and the dashboard's indexing savings for EXCLUDE_INDEX won't be real.

**4. Read the breakdown.** Below the headline cards, **Savings breakdown** shows:
- a proportional bar and the two totals, each with its share: **Ingest savings** (GB never sent) and **Indexing savings** (events dropped plus events excluded);
- a per-signal table (spans, logs, metrics) with ingest, indexing and total columns.

The headline **Estimated savings** card is now ingest + indexing.

## How it's calculated

```
ingest savings[signal]   = dropped_bytes[signal] / 10⁹ × ingest_price_per_GB[signal]
indexing savings[signal] = (dropped_events[signal] + unindexed_events[signal]) / 10⁶
                           × index_price_per_million[signal]          (spans and logs only)
estimated savings        = Σ ingest + Σ indexing
```

- **Dropped events** are the collector's existing drop counts: spans for traces, log records for logs.
- **Unindexed events** are records that survived every rule with `chopper.index = false` set by an EXCLUDE_INDEX rule. If a later DROP rule removes an excluded record, it counts as **dropped** (saving both), never as both dropped and unindexed.
- Indexing prices default to 0, so no indexing savings are claimed until you enter a price.
- **Assumption:** without Chopper, your vendor would have indexed every event it ingested. If you already exclude data vendor-side, indexing savings are overstated by that share.

Worked example (ingest $0.10/GB, spans $1.70/M, logs $2.50/M):

| | Dropped | Excluded | Ingest | Indexing |
|---|---|---|---|---|
| Spans | 4M spans, 10 GB | 1M | 10 × 0.10 = **$1.00** | 5M × 1.70 = **$8.50** |
| Logs | 20M events, 50 GB | 5M | 50 × 0.10 = **$5.00** | 25M × 2.50 = **$62.50** |

Small events cost far more to index than to ingest. At about 200 bytes per event, indexing one event at $1.70/M costs about 85× as much as ingesting it at $0.10/GB. That is why EXCLUDE_INDEX can matter even though it saves no ingest.

The code lives in `control-plane/src/lib/pricing.ts` (`computeSavings`).

## What changed

### Data plane (`chopper_filter`)

- New action `EXCLUDE_INDEX` (`ActionExcludeIndex`). On TRACES and LOGS it stamps the **record** attribute `chopper.index` with the boolean `false` and keeps evaluating later rules. It's record-level, not resource-level like ROUTE, so only matched events opt out. METRICS rules with this action are synced but skipped.
- `evaluateSpan` and `evaluateLogRecord` now return `(drop, excluded bool)`. `applyRules` counts the survivors that were excluded.
- A per-batch `batchStats` struct replaces the separate arguments to the `observe*` functions. New counters `tracesUnindexed` and `logsUnindexed` follow the usual drain/carry-over lifecycle.

### Heartbeat API

Two new optional count fields on `POST /api/v1/telemetry/:fleetId/stats`: `traces_unindexed` and `logs_unindexed`. They use the same validation as the other counts.

### Database

Migration `20260930221103_split_ingest_index_pricing`:

- `PolicyAction` enum gains `EXCLUDE_INDEX`.
- `FleetMetric` gains `tracesUnindexed` and `logsUnindexed`, as `INT` defaulting to 0.
- `PricingConfig` gains `tracesIndexPricePerMillion` and `logsIndexPricePerMillion`, as `NUMERIC(10,4)` defaulting to 0.

### Control plane

| File | Role |
|---|---|
| `src/lib/pricing.ts` | `IndexPrices`; `computeSavings` now takes dropped bytes, dropped events and unindexed events, and returns ingest and indexing splits |
| `src/app/settings/pricing/*` | Indexing price fields and validation (`NUMERIC(10,4)`, up to 4 decimals) |
| `src/app/dashboard/actions.ts` | Rejects EXCLUDE_INDEX on METRICS |
| `src/app/dashboard/action-fields.tsx` | Explains the action and the vendor filter when EXCLUDE_INDEX is selected |
| `src/app/dashboard/page.tsx` | Headline = ingest + indexing; EXCLUDE_INDEX badge and a `chopper.index=false` chip on rule cards; enforcement mirror updated |
| `src/app/dashboard/savings-breakdown.tsx` | **Savings breakdown** widget |

## Upgrading and compatibility

- **Older collectors** don't know EXCLUDE_INDEX. They skip it (fail open) and report no unindexed counts. Their drops still earn both ingest and indexing savings.
- **Older control planes** ignore the new heartbeat fields.
- Rate cards saved before this feature get indexing prices of 0, so the dollar figures don't change until you enter prices.

## Limitations

- EXCLUDE_INDEX only **marks** records; the saving depends on your vendor filter actually matching `chopper.index:false`. The dashboard can't verify that.
- Indexing savings assume 100% of ingested events would otherwise be indexed.
- One index price per signal. Vendors with several retention tiers (for example 3-day vs 15-day indexes) need the price of the tier the data would have landed in.
- The billing-period **Standard volume savings** card ([Feature 2](02-overage-tier-model.md)) and the overage model remain ingest-only, because commitments are measured in GB.

## Verification

- **`go test -race`:**
  - EXCLUDE_INDEX stamps and forwards the matched span and leaves its neighbours unstamped;
  - a later DROP wins and the span counts as dropped, not unindexed;
  - log records are stamped and counted;
  - a METRICS EXCLUDE_INDEX rule does nothing;
  - the heartbeat carries, drains and keeps unindexed counts.
- **Math:** 14 hand-worked cases pass, including the worked example above, EXCLUDE_INDEX-only savings (indexing only) and unpriced indexing (0).
- **Full stack in Docker**, with the collector built from this branch and the debug exporter in detailed mode:
  - rules created through the dashboard form, where METRICS + EXCLUDE_INDEX was rejected with a clear message; the collector reported 4 trace and 2 log rules enforced, 0 ignored;
  - rate card saved through the form: Datadog, $0.10/GB, spans $1.70/M, logs $2.50/M;
  - 200 batches gave **400 spans dropped / 400 unindexed / 47,600 B** and **600 logs dropped / 400 unindexed / 165,000 B**, matching expectations exactly;
  - forwarded 200-status spans and INFO logs carried `chopper.index: Bool(false)`; no 404 spans or DEBUG logs got through.
- **Dashboard:**
  - ingest **$0.000021**, indexing **$0.0039**, and "1,000 dropped + 800 excluded events"; the per-signal rows matched hand calculations;
  - after 200 more batches the widget updated to $0.000043 / $0.0077 without a reload.
- **Bugs fixed during testing:**
  - bar segments rendered as 2px slivers when savings were under $1, because `flex-grow` values that add up to less than 1 only get that fraction of the space; they now grow by percentage share;
  - a 0.5% share was shown as "1%"; small shares now show as "<1%" / ">99%".

## History

| Date | Change |
|---|---|
| 2026-09-30 | #35: EXCLUDE_INDEX action, unindexed counts, indexing prices, savings breakdown widget |
