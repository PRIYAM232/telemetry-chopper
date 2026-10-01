# Configure vendor pricing

A **rate card** tells Telemetry Chopper what your observability vendor charges you, so the dashboard can show savings in dollars. It holds two kinds of prices:

- **Ingest prices**, in USD per GB, for logs, traces and metrics.
- **Indexing prices**, in USD per million events, for indexed log events and indexed spans.

Until you save a rate card, every signal is priced at **$0.10 per GB** and indexing at $0.

## Before you begin

Find your negotiated prices in your vendor contract or billing console. Use the rate you actually pay, not list price.

## Save a rate card

1. On the dashboard, click **Pricing** in the header, or go to `/settings/pricing`.
2. In **Observability vendor**, choose **Datadog**, **Splunk**, **New Relic** or **Custom**. For **Custom**, also enter a **Vendor name**, for example `Grafana Cloud`.
3. Under **Ingest price, USD per GB**, enter prices for **Logs**, **Traces (spans)** and **Metrics**, with up to four decimal places (for example `0.10`). Enter `0` for a signal your vendor doesn't bill per GB, such as metrics billed per time series.
4. Under **Indexing price, USD per million events**, enter prices for **Indexed log events** and **Indexed spans** (for example `1.70`). Leave them at `0` if your vendor doesn't charge separately for indexing.
5. Click **Save rate card**.

The dashboard's savings now use your prices, and the savings card names your vendor.

## How prices are applied

| Saving | Calculated as |
|---|---|
| Ingest | GB dropped × ingest price, for each signal |
| Indexing | (events dropped + events kept out of the index) ÷ 1,000,000 × indexing price, for spans and logs |

For example, with logs at $0.10 per GB and $2.50 per million indexed events, dropping 20 million log records totalling 50 GB saves $5.00 in ingest and $50.00 in indexing.

For the complete formulas, see [How savings are calculated](calculations.md).

## Considerations

- There is one rate card per fleet.
- Indexing savings assume your vendor would otherwise index every event it ingests. If you already exclude some data from indexing on the vendor side, indexing savings are overstated by that share.
- If your vendor has several index tiers with different prices, use the price of the tier your data would have landed in.
- GB means decimal gigabytes (10⁹ bytes), the unit vendors bill in.

## Frequently asked questions

### Which vendor should I choose if mine isn't listed?

Choose **Custom** and enter your vendor's name. The vendor choice only labels the dashboard; the prices you enter drive every calculation.

### My vendor bills metrics per time series. What do I enter for metrics?

Enter `0`. Dropped metrics are still counted, but no ingest savings are claimed for them.

### Why does the indexing price use events instead of GB?

Vendors bill indexing by the number of events made searchable, not by their size, so Telemetry Chopper counts events for indexing and bytes for ingest.
