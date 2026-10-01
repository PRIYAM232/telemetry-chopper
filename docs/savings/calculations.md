# How savings are calculated

This page lists the formulas behind every dollar figure on the Telemetry Chopper dashboard. For how to configure the prices they use, see [Configure vendor pricing](configure-vendor-pricing.md).

## Inputs

Collectors measure these values and report them in every heartbeat:

| Measurement | Definition |
|---|---|
| Dropped bytes | The OTLP protobuf size of each span, log record or metric removed by DROP, SAMPLE or THROTTLE rules. Resource and scope information shared with records that were kept isn't included, so this can slightly undercount but never overcounts. |
| Forwarded bytes | The OTLP protobuf size of each batch passed downstream, including resource and scope information, as your exporter sends it. |
| Dropped events | The number of spans and log records removed. |
| Unindexed events | The number of spans and log records forwarded with `chopper.index = false` by an EXCLUDE_INDEX rule. A record that's marked and later dropped counts as dropped. |

Your settings provide:

| Setting | Symbol |
|---|---|
| Ingest price per GB, per signal | *r* |
| Indexing price per million events, for spans and logs | *i* |
| Egress price per GB | *e* |
| Wire compression ratio | *k* |
| Committed volume, in GB per month | *C* |
| Overage multiplier | *m* |

All volumes use decimal units: 1 GB = 10⁹ bytes.

## Vendor savings

For each signal:

```
ingest savings   = dropped GB × r
indexing savings = (dropped events + unindexed events) ÷ 1,000,000 × i     (spans and logs only)
```

**Estimated savings** on the dashboard is the sum of ingest and indexing savings across all signals.

## Egress savings

When egress savings are turned on:

```
egress savings = (dropped GB, all signals ÷ k) × e
```

Per-signal egress uses each signal's dropped GB, so the rows of the **Savings breakdown** table add up to the total. With egress on, the headline card shows **Total infrastructure & ingest savings**: ingest + indexing + egress.

## Overage

For the current billing period, where *F* is billable (forwarded) GB, *D* is dropped GB and *W* = *F* + *D* is the volume without Telemetry Chopper:

```
standard volume savings = Σ over signals (D × r)
GB kept out of overage  = max(0, W − C) − max(0, F − C)
overage penalty avoided = GB kept out of overage × r_blended × (m − 1)
overage incurred        = max(0, F − C) × r_blended × m
```

- *r_blended* is your ingest price weighted by the period's mix of signals: the mix without Telemetry Chopper for penalty avoided, and the billable mix for overage incurred. When every signal has the same price, *r_blended* is that price.
- With one price for all signals, standard volume savings + overage penalty avoided equals exactly the difference between your bill without Telemetry Chopper and your bill with it.
- **Projection:** billable GB so far ÷ fraction of the period elapsed. In the first 2% of a period, the projection is the volume so far.

## Rule savings

A rule's **saves** figure applies the vendor and egress formulas above to the records that rule dropped or kept out of the index. Because each dropped record is credited to exactly one rule, the figures on all rule cards add up to the headline savings.

## Worked example

A fleet with logs priced at $0.10 per GB ingest and $2.50 per million indexed events, egress on at $0.09 per GB with 4:1 compression, drops 500 GB of logs (2.5 million events) in a day:

| Saving | Calculation | Result |
|---|---|---|
| Ingest | 500 × $0.10 | $50.00 |
| Indexing | 2.5 × $2.50 | $6.25 |
| Egress | (500 ÷ 4) × $0.09 | $11.25 |
| **Total** | | **$67.50** |
