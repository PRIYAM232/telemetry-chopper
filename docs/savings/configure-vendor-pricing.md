# Configure vendor pricing

A **rate card** tells Telemetry Chopper what your observability vendor charges you, so the dashboard can show savings in dollars. It holds three kinds of prices:

- **Ingest prices**, in USD per GB, for logs, traces and metrics.
- **Indexing prices**, in USD per million events, for indexed log events and indexed spans.
- A **metric series price**, in USD per 100 series per month, for vendors that bill custom metrics by series instead of by volume, such as Datadog.

Until you save a rate card, every signal is priced at **$0.10 per GB**, and indexing and metric series at $0.

## Before you begin

Find your negotiated prices in your vendor contract or billing console. Use the rate you actually pay, not list price.

## Save a rate card

1. On the dashboard, click **Pricing** in the header, or go to `/settings/pricing`.
2. In **Observability vendor**, choose **Datadog**, **Splunk**, **New Relic** or **Custom**. For **Custom**, also enter a **Vendor name**, for example `Grafana Cloud`.
3. Under **Ingest price, USD per GB**, enter prices for **Logs**, **Traces (spans)** and **Metrics**, with up to four decimal places (for example `0.10`). Enter `0` for a signal your vendor doesn't bill per GB, such as metrics billed per time series.
4. Under **Indexing price, USD per million events**, enter prices for **Indexed log events** and **Indexed spans** (for example `2.04`). Leave them at `0` if your vendor doesn't charge separately for indexing.
5. Under **Metric series price, USD per 100 series per month**, enter your price if your vendor bills custom metrics by series (for example `5.00`, Datadog's monthly-plan list price). Set the metrics ingest price to `0` in that case, so metrics aren't priced twice. Leave it at `0` if your vendor bills metrics by volume.
6. Click **Save rate card**.

The dashboard's savings now use your prices, and the savings card names your vendor.

## How prices are applied

| Saving | Calculated as |
|---|---|
| Ingest | GB dropped × ingest price, for each signal |
| Indexing | (events dropped + events kept out of the index) ÷ 1,000,000 × indexing price, for spans and logs |
| Metric series | series-hours dropped ÷ 730 ÷ 100 × series price |

For example, with logs at $0.10 per GB and $2.50 per million indexed events, dropping 20 million log records totalling 50 GB saves $5.00 in ingest and $50.00 in indexing.

Series-billing vendors count a month's custom metrics as the average number of distinct series per hour. A **series-hour** is one series dropped for one hour, and a month has 730 hours. So with Datadog's $5.00 per 100 series, rules that drop 1,000 series for a whole month save $50.00, and rules that drop them for one day save about $1.64.

For the complete formulas, see [How savings are calculated](calculations.md).

## Considerations

- There is one rate card per fleet.
- Indexing savings assume your vendor would otherwise index every event it ingests. If you already exclude some data from indexing on the vendor side, indexing savings are overstated by that share.
- If your vendor has several index tiers with different prices, use the price of the tier your data would have landed in.
- GB means decimal gigabytes (10⁹ bytes), the unit vendors bill in.
- A **metric series** is a metric name plus one combination of datapoint attributes and the resource's `host.name`, which vendors such as Datadog turn into the `host` tag. Other resource attributes aren't included, because vendors only turn some of them into tags. Series savings therefore err low rather than high.
- A series only counts when a rule drops its datapoints. If the same series also reaches your vendor another way, for example from a collector without the rule, your vendor still bills it.
- Datadog bills a histogram or distribution as several custom metrics (count, sum, percentiles and so on). Telemetry Chopper counts each as one series, so savings for those err low.
- Each collector tracks up to 100,000 dropped series per hour. Beyond that, the count stops growing for the rest of the hour.

## Frequently asked questions

### Which vendor should I choose if mine isn't listed?

Choose **Custom** and enter your vendor's name. The vendor choice only labels the dashboard; the prices you enter drive every calculation.

### My vendor bills metrics per time series. What do I enter for metrics?

Enter `0` as the metrics ingest price and your price per 100 series as the **Metric series price**. Savings then come from the series your rules drop, not their bytes. Dropping some datapoints of a series that still reaches your vendor saves nothing, and Telemetry Chopper only counts a series when a rule dropped it.

### Why are my metric series savings $0?

Check that the rate card has a metric series price, and that your collectors are on a version that reports dropped series. Older collectors report none. Series savings also need a rule that drops metrics: SAMPLE and REDACT don't apply to metrics.

### Why does the indexing price use events instead of GB?

Vendors bill indexing by the number of events made searchable, not by their size, so Telemetry Chopper counts events for indexing and bytes for ingest.
