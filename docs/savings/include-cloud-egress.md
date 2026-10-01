# Include cloud egress savings

If your collectors run in a cloud such as AWS, Google Cloud or Azure and send telemetry out of it, for example to a SaaS vendor over the internet or to another region, your cloud provider charges an **egress** (outbound data transfer) fee on every GB. Data your rules drop in the collector never leaves the network, so it saves egress as well as your vendor's charges.

When you turn on egress savings, the dashboard adds them to your vendor savings and shows a combined **Total infrastructure & ingest savings**.

## Before you begin

Decide whether egress applies to you. Leave it off if your collectors reach your vendor through a private link in the same region, where telemetry isn't charged for egress.

## Turn on egress savings

1. On the dashboard, click **Pricing** in the header, or go to `/settings/pricing`.
2. Under **Cloud egress**, select **Include cloud egress savings**.
3. In **Egress price (USD / GB)**, enter your provider's rate for the path your telemetry takes: internet, cross-region or between clouds. The default, **$0.09**, is AWS's first tier for internet egress.
4. In **Wire compression ratio**, enter how much your exporters compress data on the wire, for example `4` for 4:1. `4:1` is also accepted. Use `1` if you send uncompressed data.
5. Click **Save egress settings**.

The dashboard's headline card becomes **Total infrastructure & ingest savings**, and the **Savings breakdown** adds a **Cloud egress savings** segment and an **Egress** column.

To turn egress savings off, clear **Include cloud egress savings** and save. Your rate and compression ratio are kept for later.

## Why the compression ratio matters

Cloud providers bill the bytes actually sent over the network. OTLP exporters compress data with gzip by default, so the bytes on the wire are usually a fraction of the data's uncompressed size. Telemetry Chopper measures uncompressed size, so it divides by your compression ratio before applying the egress price:

```
egress savings = (GB dropped ÷ compression ratio) × egress price per GB
```

For example, 500 GB of dropped logs at 4:1 compression is 125 GB on the wire. At $0.09 per GB, that saves **$11.25** in egress.

To find your ratio, compare the volume your collectors send, from your cloud provider's network metrics, with the uncompressed volume they forward. The dashboard shows that as **Billable volume** in **This billing period** once you [set a commitment](track-committed-volume.md).

## Considerations

- **Only dropped data saves egress.** Records forwarded with ROUTE, REDACT or EXCLUDE_INDEX rules still leave the network.
- **One rate per fleet.** If some collectors use a private link and others the internet, or your provider charges less per GB at higher volumes, enter a blended rate.
- **Compression varies.** The ratio you enter is an average. Real ratios depend on payload content and exporter settings.
- Billing period figures don't include egress.

## Frequently asked questions

### Which egress rate should I use?

Use the rate for the network path between your collectors and your vendor. Internet egress is typically the most expensive. Traffic between regions or availability zones of the same provider is usually cheaper. Check your provider's pricing page or your bill for the exact rate.

### Does egress apply to collectors running on premises?

Usually not. If your on-premises network charges for outbound transfer, enter that rate. Otherwise leave egress savings off.
