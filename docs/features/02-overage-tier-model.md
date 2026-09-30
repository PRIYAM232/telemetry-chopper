# Feature 2: Overage tier modeling

**Status:** Shipped, 2026-09-30 · **PR:** [#33](https://github.com/PRIYAM232/telemetry-chopper/pull/33)

## Summary

Many observability contracts include a **committed monthly volume** billed at the standard rate, and charge a **penalty multiplier** (often 1.5× or 2×) on every GB beyond it. This feature tracks each billing period's billable volume against your commitment, shows when you crossed it (or when you're on pace to), and splits savings into two figures:

- **Standard volume savings:** every GB your rules dropped this period, at your rate card (the [Feature 1](01-vendor-rate-cards.md) figure, limited to this period).
- **Overage penalty avoided:** the extra premium you would have paid on the GB that, without Chopper, would have fallen past your commitment.

## Using it

1. Save your [rate card](01-vendor-rate-cards.md) first. The overage model prices GB with it, or with the $0.10/GB default if none is saved.
2. On `/settings/pricing`, under **Volume commitment**, enter:
   - **Committed volume (GB / month)**, for example `5000` (commas are fine);
   - **Overage multiplier**: `1` means no penalty, `1.5` means 150%, `2` means double (a trailing `x` is fine);
   - **Billing cycle starts on day**, from 1 to 28.
3. Click **Save commitment**. The dashboard's new **This billing period** section shows:
   - **Standard volume savings** and **Overage penalty avoided** cards;
   - a **Billable volume** meter (percent of commitment) with a status line:
     - ✓ within commitment, with the projected share by period end;
     - ! at least 90% used, or on pace to exceed;
     - ▲ over commitment since a date, with GB and dollars billed at the penalty rate;
   - a **Cumulative volume** chart of *billable (with Chopper)* and *without Chopper* against the commitment line, with a hover tooltip and a table view.

Everything refreshes with the dashboard every 10 seconds.

## How it's calculated

For the current billing period, per signal:

- **F** = forwarded bytes (what reached the vendor: billable volume);
- **D** = dropped bytes;
- **W** = F + D (what the vendor would have billed without Chopper);
- **C** = committed volume;
- **m** = overage multiplier;
- **r** = rate-card price per GB.

```
standard savings  = Σ over signals ( D[signal] / 10⁹ × r[signal] )
avoided overage   = max(0, W − C) − max(0, F − C)          (GB kept out of the penalty tier)
penalty avoided   = avoided overage × r_blended × (m − 1)
overage incurred  = max(0, F − C) × r_blended(F) × m
```

- `r_blended` is the rate weighted by the period's without-Chopper signal mix, and `r_blended(F)` by the billable mix. With one price across all signals, **standard + penalty = cost(W) − cost(F)** exactly: the whole bill difference.
- The penalty figure counts only the *premium* (m − 1). The base rate on those GB is already in standard savings, so nothing is counted twice. At m = 1 the penalty is 0.
- **Billing period:** from the cycle day at 00:00 UTC to the same day next month. For example, cycle day 15 gives Sep 15 – Oct 14.
- **Crossing dates** come from daily cumulative sums of F and W.
- **Projection:** F ÷ (fraction of the period elapsed). In the first 2% of a period it's just the volume so far, because extrapolating from minutes of data would be noise.

Worked example (one price of $0.10/GB, C = 100 GB, m = 1.5, F = 90 GB, D = 60 GB, so W = 150 GB):

- standard savings = 60 × $0.10 = **$6.00**;
- avoided overage = 50 − 0 = 50 GB, so penalty avoided = 50 × $0.10 × 0.5 = **$2.50**;
- check: cost(W) = 100 × 0.10 + 50 × 0.15 = $17.50, cost(F) = $9.00, and $17.50 − $9.00 = $8.50 = $6.00 + $2.50 ✓.

The code lives in `control-plane/src/lib/overage.ts` (`billingPeriod`, `getPeriodVolumes`, `modelOverage`).

## What changed

### Data plane (`chopper_filter`)

- After the rules run, each signal's consume path sizes the surviving batch with `TracesSize` / `LogsSize` / `MetricsSize`. That includes envelopes, as the exporter will ship them. Fully-dropped batches skip it.
- **Cost:** about 31 µs per 512-span batch (roughly 60 ns per span), about a third of an OTLP marshal of the same batch.
- The new `byteVolume{dropped, forwarded}` type feeds per-signal `*ForwardedBytes` counters, with the same drain/carry-over lifecycle as the other counters.

### Heartbeat API

Three more optional integer fields on `POST /api/v1/telemetry/:fleetId/stats`: `traces_forwarded_bytes`, `logs_forwarded_bytes` and `metrics_forwarded_bytes`. The validation rules are the same as for the dropped-byte fields.

### Database

Migration `20260930214953_volume_commitment_and_forwarded_bytes`:

- `FleetMetric` gains `tracesForwardedBytes`, `logsForwardedBytes` and `metricsForwardedBytes`, as `BIGINT` defaulting to 0.
- New table `VolumeCommitment`, one row per fleet (primary key `fleetId`):
  - `committedGbPerMonth` as `NUMERIC(14,3)`;
  - `overageMultiplier` as `NUMERIC(5,2)`, validated to 1–10;
  - `billingCycleDay` as `INT`, 1–28.

The period query is one raw `GROUP BY date_trunc('day', "createdAt")`, so a month of 10 s heartbeats (hundreds of thousands of rows per collector) arrives as about 31 daily sums. It uses the existing `(fleetId, createdAt)` index.

### Control plane

| File | Role |
|---|---|
| `src/lib/overage.ts` | Billing periods, daily volume query, `modelOverage` |
| `src/app/settings/pricing/commitment-form.tsx` | Volume commitment form |
| `src/app/settings/pricing/actions.ts` | `saveCommitmentAction` (validation matches the column types) |
| `src/app/dashboard/billing-period.tsx` | **This billing period** section (server component) |
| `src/app/dashboard/overage-chart.tsx` | Cumulative chart with hover layer and table view (client component) |

## Upgrading and compatibility

- Collectors that report no forwarded bytes still work. Their heartbeats are counted and flagged: *"N heartbeats this period carried no volume data — billable volume is understated until every collector is upgraded."*
- Periods that began before the upgrade understate billable volume until they roll over.

## Limitations

- **Prepaid commitments:** if your commitment is prepaid, dropping data *below* the commitment line saves no cash that period. The penalty-avoided figure is the one that reflects real money.
- **ROUTE to cold storage** still counts as billable. The collector can't tell which destinations your vendor bills, so billable volume may be a little high, and the penalty tier may appear closer than it really is.
- **Mixed prices:** with different prices per signal, overage GB are priced at the period's blended rate rather than tracking which signal's bytes landed past the line.
- **Periods** are UTC only. There is one commitment per fleet, covering all signals combined.
- Measurements are OTLP protobuf sizes, not your vendor's own ingest encoding (as in Feature 1).

## Verification

- `go test -race`:
  - forwarded bytes equal the surviving batch's size for each signal;
  - a fully-dropped batch forwards 0;
  - the heartbeat carries forwarded bytes, drains them on success and keeps them on failure.
- **Model checks:** 21 hand-worked cases pass. They cover standard + penalty = cost(W) − cost(F), a 1× multiplier, per-signal blended rates, the projection, and period boundaries (the cycle-day edge and year-end).
- **Browser, against a seeded month** checked with an independent Python calculation (5 TB commitment, 1.5×, spike on Sep 18–22):
  - standard savings **$323.00** and penalty avoided **$165.66**;
  - crossings on **Sep 20** without Chopper and **Sep 28** with it;
  - **108.0%** used, with 400 GB of overage costing **$71.67**;
  - an out-of-period row is excluded, and an old collector's heartbeat is flagged.
- **Browser tests of the form:**
  - a 0.8 multiplier is rejected, and "5,000" and "1.5x" are accepted;
  - 6000 GB with cycle day 15 re-scopes the period to Sep 15–Oct 14, with $223.60 savings, 50.3% used and "on pace for 95%".
- **Full stack in Docker:** the real collector's bytes matched an independent Go size check exactly:
  - dropped 47,600 / 165,000 / 11,000 B;
  - forwarded 56,400 / 24,800 / 18,800 B.

## History

| Date | Change |
|---|---|
| 2026-09-30 | #33: forwarded-byte measurement, volume commitment, overage model, billing-period dashboard section |
