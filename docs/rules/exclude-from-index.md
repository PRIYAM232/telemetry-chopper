# Keep events out of your vendor's index

Many observability vendors bill twice for the same data: once to **ingest** it (per GB) and again to **index** it for search (per million events). Indexing is often the larger charge. At around 200 bytes per event, indexing an event at $1.70 per million costs about 85 times as much as ingesting it at $0.10 per GB.

The **EXCLUDE_INDEX** action lets you keep sending data your vendor needs for live tail, metrics generated from logs or archives, without paying to make it searchable. Matching spans and log records are forwarded as usual, with the record attribute `chopper.index` set to `false`. A matching exclusion filter in your vendor then keeps them out of the index.

## Before you begin

- EXCLUDE_INDEX applies to **traces and logs** only. Metrics aren't indexed events, so the dashboard rejects the action on METRICS rules.
- To see indexing savings in dollars, add your indexing prices to your rate card. See [Configure vendor pricing](../savings/configure-vendor-pricing.md).

## Exclude events from indexing

1. On the dashboard, in the **New rule** form, choose the action **EXCLUDE_INDEX** and the signal **LOGS** or **TRACES**.
2. Enter a condition for the events to exclude, for example `log.severity` `EQUALS` `INFO`.
3. Click **Create rule**. The rule card shows a `chopper.index=false` badge.
4. In your vendor, add an index exclusion filter on the attribute. For example, in a Datadog log index, add an exclusion filter with the query `@chopper.index:false`.

> **Important:** Telemetry Chopper only marks the events. Your vendor's exclusion filter is what stops them being indexed. Without the filter, your vendor keeps indexing them and the dashboard's indexing savings for this rule won't be realized.

## How it works

- Only the matching record is marked, not its neighbors from the same service.
- Evaluation continues after an EXCLUDE_INDEX rule. If a later rule drops the record, it counts as dropped, which saves ingest and indexing, rather than as excluded.
- The dashboard counts each forwarded, marked record as one event of **indexing savings**, priced at your indexing rate for that signal. Excluded records save no ingest or egress, because they are still sent.

## What it saves compared with dropping

| What happens to a record | Ingest saved | Indexing saved | Egress saved |
|---|---|---|---|
| Dropped (DROP, SAMPLE, THROTTLE) | ✓ | ✓ | ✓ |
| Excluded from the index (EXCLUDE_INDEX) | | ✓ | |
| Forwarded normally | | | |

## Considerations

- Indexing savings assume your vendor would otherwise have indexed every event it ingested. If you already exclude some data on the vendor side, the dashboard overstates indexing savings by that share.
- The rate card holds one indexing price per signal. If your vendor has several index tiers (for example 3-day and 15-day retention), use the price of the tier the data would have gone to.

## Frequently asked questions

### Should I use EXCLUDE_INDEX or DROP?

Use DROP for data nobody needs. Use EXCLUDE_INDEX for data you still need to receive, for example to watch in live tail, to generate metrics from, or to archive, but don't need to search.

### Does EXCLUDE_INDEX work with vendors other than Datadog?

Yes, if your vendor can exclude events from indexing or retention based on an attribute. Configure the equivalent filter on `chopper.index = false`.

### Why don't I see indexing savings on the dashboard?

Indexing prices default to $0. Enter your vendor's price per million indexed log events and spans on the **Pricing** page.
