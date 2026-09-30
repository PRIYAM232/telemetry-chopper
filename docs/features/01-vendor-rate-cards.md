# Feature 1: Vendor rate cards

**Status:** Shipped, 2026-09-30 · **PRs:** [#31](https://github.com/PRIYAM232/telemetry-chopper/pull/31) (feature), [#32](https://github.com/PRIYAM232/telemetry-chopper/pull/32) (sub-cent display fix)

## Summary

The dashboard's **Estimated savings** figure is now *GB dropped × your negotiated price per GB*, for each signal (traces, logs, metrics). You pick your observability vendor (Datadog, Splunk, New Relic or Custom) and enter the per-GB ingest prices from your contract.

Before this feature, savings were *dropped record count × a hardcoded $0.15 per million records*. Vendors bill ingest per GB, not per record, so the collector now measures the bytes it drops.

## Using it

1. Open the dashboard and click **Pricing** in the header (or go to `/settings/pricing`).
2. Choose your vendor. For **Custom**, also enter a display name (for example "Grafana Cloud").
3. Enter your price in USD per GB for **Logs**, **Traces (spans)** and **Metrics**, with up to 4 decimal places. Use `0` for a signal your vendor doesn't bill per GB (metrics are often billed per series).
4. Click **Save rate card**. The dashboard's savings card now shows your vendor's name and your prices.

Until a rate card is saved, every signal is priced at a default **$0.10/GB**, and the card links to the settings page.

## How it's calculated

```
savings = Σ over signals ( dropped_bytes[signal] / 10⁹ × price_per_GB[signal] )
```

- **Dropped bytes** are the OTLP protobuf size of each removed span, log record or metric, measured by the collector when it drops the record. Resource and scope envelopes shared with surviving records are left out, so the figure can undercount wire volume slightly but never overcounts.
- **GB** means decimal gigabytes (10⁹ bytes), the unit vendors bill.
- Only records the ruleset **removes** count: DROP, unsampled SAMPLE, and THROTTLE beyond its rate. REDACT and ROUTE never drop anything, so they never count as savings.
- Savings of less than a cent keep two significant digits (`$0.000022`), so a small fleet never shows `$0.0000` next to real drops.

The code lives in `control-plane/src/lib/pricing.ts` (`computeSavings`).

## What changed

### Data plane (`chopper_filter`)

- In each signal's `applyRules`, the drop path sizes each removed record with pdata's `ProtoMarshaler` (`SpanSize`, `LogRecordSize`, `MetricSize`). Batches the ruleset doesn't touch cost nothing extra.
- New per-signal counters (`tracesDroppedBytes`, `logsDroppedBytes`, `metricsDroppedBytes`) follow the same heartbeat lifecycle as the record counts: a successful report drains them, and a failed one carries them over to the next report.

### Heartbeat API

`POST /api/v1/telemetry/:fleetId/stats` accepts three new optional integer fields:

| Field | Meaning |
|---|---|
| `traces_dropped_bytes` | OTLP bytes of dropped spans this interval |
| `logs_dropped_bytes` | OTLP bytes of dropped log records this interval |
| `metrics_dropped_bytes` | OTLP bytes of dropped metrics this interval |

A missing field reads as 0. A negative or non-integer value is rejected with `400`. Values are capped at `Number.MAX_SAFE_INTEGER`.

### Database

Migration `20260930211512_pricing_rate_cards_and_dropped_bytes`:

- `FleetMetric` gains `tracesDroppedBytes`, `logsDroppedBytes` and `metricsDroppedBytes`. They are `BIGINT`, default 0, because a busy fleet can drop more than 2 GiB in one interval.
- New enum `ObservabilityVendor`: `DATADOG`, `SPLUNK`, `NEW_RELIC`, `CUSTOM`.
- New table `PricingConfig`, one row per fleet (primary key `fleetId`):
  - `vendor`;
  - `customVendorName`, which is cleared when you switch to a named vendor;
  - `tracesPricePerGb`, `logsPricePerGb` and `metricsPricePerGb`, stored as `NUMERIC(10,4)`.

### Control plane

| File | Role |
|---|---|
| `src/lib/pricing.ts` | Service layer: `getRateCard`, `saveRateCard`, `computeSavings`, defaults, vendor labels |
| `src/app/settings/pricing/page.tsx` | Pricing configuration page |
| `src/app/settings/pricing/pricing-form.tsx` | Rate-card form (client component, inline validation errors) |
| `src/app/settings/pricing/actions.ts` | `savePricing` server action; prices must match `NUMERIC(10,4)` exactly |
| `src/app/dashboard/page.tsx` | Savings card priced by the rate card; **Pricing** link in the header |
| `src/lib/format.ts` | `formatUSD` (sub-cent aware), `formatBytes` |

## Upgrading and compatibility

- **Control plane first, collectors later** is safe. Old collectors omit the byte fields, so their drops are still counted, just not priced. The savings card shows *"N earlier drops unpriced (no byte data)"* for them.
- **Collectors first** is safe too: an older control plane ignores keys it doesn't know.
- Historic `FleetMetric` rows keep 0 bytes. Savings from before the upgrade are not back-filled.

## Limitations

- The dollar figure is an estimate. Vendors bill their own ingest encoding, not OTLP protobuf, so it's close but not exact.
- There is one rate card per fleet, and the dashboard shows the first fleet only (as before this feature).
- The control plane has no operator authentication yet, so anyone who can reach the dashboard can edit prices. This applies to every server action; see the security section of the main README.

## Verification

- `go test -race`: byte assertions for each signal, plus a heartbeat test covering the payload, draining after a successful report, and carry-over after a failed one.
- Browser tests of the form:
  - a custom vendor saves and the dashboard reprices;
  - a 5-decimal price is rejected by the browser, and by the server when the browser check is bypassed, with the typed value kept for fixing;
  - switching vendors clears the custom name.
- Full stack in Docker (Postgres, control plane, and the collector built with `ocb`):
  - the collector's byte totals matched an independent Go size check **exactly**: 47,600 / 165,000 / 11,000 B for traces / logs / metrics over 200 batches;
  - the dashboard showed the expected $0.15 for the rates entered;
  - the figure updated live, without a page reload.

## History

| Date | Change |
|---|---|
| 2026-09-30 | #31: rate cards, dropped-byte measurement, pricing page |
| 2026-09-30 | #32: sub-cent savings show two significant digits instead of `$0.0000` (found in end-to-end testing) |
| 2026-09-30 | #35 ([Feature 3](03-split-ingest-indexing.md)): the headline card becomes ingest + indexing savings; `computeSavings` takes event counts as well as bytes |
| 2026-09-30 | #36 ([Feature 4](04-cloud-egress.md)): with cloud egress on, the headline card becomes **Total infrastructure & ingest savings** |
