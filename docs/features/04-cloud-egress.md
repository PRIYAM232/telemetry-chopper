# Feature 4: Cloud egress savings

**Status:** Shipped, 2026-09-30 · **PR:** [#36](https://github.com/PRIYAM232/telemetry-chopper/pull/36)

## Summary

When your collectors run in a cloud and ship telemetry out of it (to a SaaS vendor over the internet, or to another region), the cloud provider charges an **outbound data transfer (egress) fee** on every GB. Every byte your rules drop in the collector never leaves the network, so it saves egress on top of the vendor's ingest and indexing charges.

This feature adds a **cloud egress** toggle and rate to the cost settings. When it's on, the dashboard adds egress savings next to the vendor savings, and the headline card becomes **Total infrastructure & ingest savings**.

## Using it

1. On `/settings/pricing`, under **Cloud egress**:
   - tick **Include cloud egress savings**. Leave it off if your collectors reach the vendor over a same-region private link, where telemetry pays no egress.
   - **Egress price (USD / GB)** defaults to **$0.09**, AWS's first internet-egress tier. Use the rate for the path your telemetry actually takes: internet, cross-region, or inter-cloud.
   - **Wire compression ratio** defaults to `1`. Providers bill **compressed bytes on the wire**, but Chopper measures uncompressed OTLP. OTLP exporters gzip by default, so enter the ratio you observe, for example `4` for 4:1 (`4:1` is also accepted).
2. Click **Save egress settings**. Turning the toggle off keeps your saved rate and ratio for later.
3. On the dashboard:
   - the headline card becomes **Total infrastructure & ingest savings** (vendor ingest + indexing + cloud egress);
   - the **Savings breakdown** widget gains a third segment, **Cloud egress savings**, labelled *Cloud provider* to set it apart from the *Observability vendor* segments. Its header reads `Vendor $X + egress $Y = Total $Z`, and the per-signal table gains an **Egress** column.

While the toggle is off, the headline stays **Estimated savings** and the widget offers a link to turn egress on.

## How it's calculated

```
wire bytes      = dropped_bytes (all signals) / compression_ratio
egress savings  = wire bytes / 10⁹ × egress_price_per_GB      (0 when the toggle is off)
total savings   = ingest + indexing (Feature 3) + egress savings
```

- **Only dropped records save egress.** Records an EXCLUDE_INDEX rule marks, a ROUTE rule tags, or REDACT scrubs still leave the network.
- **Per-signal egress** in the table applies the same formula to each signal's dropped bytes, so the three rows add up to the egress total.
- **Worked example** (live dashboard test): 500 GB of dropped logs at 4:1 compression is 125 GB on the wire. At $0.09/GB that's **$11.25** egress, next to $50.00 ingest and $6.25 indexing: a total of **$67.50** (74% / 9% / 17%).

The code lives in `control-plane/src/lib/egress.ts` (`computeEgressSavings`).

## What changed

### Data plane and heartbeat API

No changes. Egress savings reuse the dropped-byte measurement from [Feature 1](01-vendor-rate-cards.md).

### Database

Migration `20260930222322_cloud_egress_config` adds a new table `EgressConfig`, one row per fleet (primary key `fleetId`):

- `enabled` (`BOOLEAN`, default false);
- `pricePerGb` (`NUMERIC(10,4)`, default 0.09);
- `compressionRatio` (`NUMERIC(6,2)`, default 1, validated to 1–100).

### Control plane

| File | Role |
|---|---|
| `src/lib/egress.ts` | `getEgressConfig`, `saveEgressConfig`, `computeEgressSavings`, defaults |
| `src/app/settings/pricing/egress-form.tsx` | Toggle, price and compression inputs. Disabled inputs carry their saved values in hidden fields, so turning egress off doesn't wipe them |
| `src/app/settings/pricing/actions.ts` | `saveEgressAction` validation: price `NUMERIC(10,4)`, ratio 1–100 |
| `src/app/dashboard/page.tsx` | Headline = vendor + egress when enabled; hint names both rates |
| `src/app/dashboard/savings-breakdown.tsx` | Egress segment (categorical slot 3, aqua), payee labels, vendor + egress = total header, Egress column |
| `src/lib/pricing.ts` | `Savings.droppedBytesBySignal` for per-signal egress |

## Upgrading and compatibility

- Egress is **off** for every fleet until someone turns it on, so existing dashboards show the same numbers after upgrading.
- Works with any collector that reports dropped bytes (Feature 1 or later). Drops from older collectors are unpriced here, just as they are for ingest.

## Limitations

- **One rate per fleet.** Mixed paths (some collectors on a private link, some on the internet) and tiered egress pricing (cheaper per GB above 10 TB/month) need a blended rate.
- **Compression is a ratio you enter, not a measurement.** Real ratios vary with payload content and exporter settings.
- **Dropped bytes only.** EXCLUDE_INDEX, ROUTE and REDACT don't reduce what leaves the network, so they don't count.
- Billing-period figures ([Feature 2](02-overage-tier-model.md)) don't include egress.

## Verification

- **Math:** 9 hand-worked `computeEgressSavings` cases pass:
  - off gives $0 but still reports wire bytes;
  - 100 GB at 1:1 and $0.09 gives $9;
  - 100 GB at 4:1 gives 25 GB on the wire and $2.25;
  - cross-region at $0.02/GB.
- **Palette:** the three-slot palette (blue / orange / aqua) passes every hard check in the data-viz validator in both light and dark mode. The one warning (aqua is below 3:1 contrast in light mode) is covered by the direct labels and the table.
- **Full stack in Docker**, built from this branch:
  - collector bytes matched expectations exactly (47,600 / 165,000 / 11,000 B);
  - egress off: headline "Estimated savings" at $0.0032, no egress segment or column, "turn on" prompt shown;
  - the form rejected a 0.5 compression ratio ("between 1 (uncompressed) and 100"); on, $0.09, 4:1 saved;
  - egress on: 55.9 KB on the wire gave **$0.000005** egress, per-signal egress of $0.0000011 / $0.0000037 / $0.00000025, and the headline renamed;
  - turning egress off kept `0.0900` / `4.00` in the database, and turning it back on restored them;
  - live, without a reload, a 500 GB log heartbeat moved the widget to **$50.00 + $6.25 + $11.25 = $67.50**, matching hand calculation;
  - screenshots checked in dark and light mode, with the computed segment colors matching each mode's palette values.

## History

| Date | Change |
|---|---|
| 2026-09-30 | #36: egress toggle, rate and compression config; egress segment, column and combined total |
