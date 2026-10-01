# Measure observability savings

Telemetry Chopper measures what your rules keep away from your observability vendor and turns it into dollars using your own contract prices. Collectors measure the exact size of every record they drop and forward, and report it every 10 seconds, so the dashboard reflects your current traffic, not an estimate based on averages.

## What the dashboard shows

The top of the dashboard has four cards:

| Card | What it shows |
|---|---|
| **Telemetry processed** | Spans, log records and metrics received by your collectors |
| **Telemetry dropped** | Records your rules removed |
| **Data reduction** | Dropped as a percentage of processed |
| **Estimated savings** | Vendor ingest plus indexing savings, at your rate card. When cloud egress is turned on, this card becomes **Total infrastructure & ingest savings** and adds egress savings. |

Below the cards:

- **Savings breakdown** splits total savings by what each dollar pays for: **Ingest savings** (GB never sent to the vendor), **Indexing savings** (events never indexed) and, when enabled, **Cloud egress savings**. It includes a per-signal table for spans, logs and metrics.
- **This billing period** tracks billable volume against your monthly commitment and shows the overage penalties your rules prevented. It appears once you set a commitment. See [Track a committed volume and overage penalties](track-committed-volume.md).
- Each rule card shows what that rule matched, dropped and saved. See [Monitor what each rule is doing](../rules/monitor-rule-activity.md).

The dashboard refreshes every 10 seconds.

## Choose a time range

Above the savings cards, choose **1h**, **24h** (the default), **7d** or **All time**. The four cards, the **Savings breakdown** and every rule card's counts cover the range you choose. The heading above the cards names it, for example *Savings over the last 24 hours*.

Use a short range to see what your current rules achieve. Long ranges include traffic from before you added or changed rules, so they understate the effect of recent changes. For example, a rule that drops 88% of traffic can show as 20% under **All time** if most of your history predates it.

The range is stored in the page address (for example `/dashboard?range=1h`), so you can bookmark or share a view.

If no collector reported during the range, the heading says *no heartbeats in this window* and **Data reduction** shows **—**.

**This billing period** always covers your billing cycle, whatever range you choose.

## Set up savings tracking

Savings are priced at a default of **$0.10 per GB** until you enter your own rates. To match your bill:

1. [Configure vendor pricing](configure-vendor-pricing.md) with your negotiated ingest and indexing prices.
2. Optionally, [track a committed volume](track-committed-volume.md) if your contract has one.
3. Optionally, [include cloud egress savings](include-cloud-egress.md) if your collectors send telemetry out of a cloud network.

To see exactly how each figure is computed, see [How savings are calculated](calculations.md).

## Frequently asked questions

### How accurate are the savings figures?

Collectors measure the exact OTLP size of every record they drop and forward. Your vendor bills its own ingest format, which differs slightly from OTLP, so dollar figures are close estimates rather than an exact match to your invoice.

### Why does Data reduction change when I switch time range?

Each range includes different traffic. A range that starts before you added a rule includes traffic the rule never saw, which lowers the percentage.

### Why does the savings card say some drops are unpriced?

Collectors released before byte measurement report how many records they dropped but not how large they were. Those drops are counted but can't be priced. Upgrade your collectors to price them.

### Do savings include data sent with ROUTE or REDACT rules?

No. ROUTE and REDACT never remove data, so the vendor still receives and bills it. Only dropped records (DROP, SAMPLE, THROTTLE) save ingest and egress, and only dropped or index-excluded records save indexing.
