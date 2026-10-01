# Track a committed volume and overage penalties

Many observability contracts include a **committed volume**: a number of GB per month billed at your standard rate. Every GB past it is **overage**, billed at a multiple of the standard rate, often 1.5× or 2×.

When you enter your commitment, the dashboard tracks each billing period's billable volume against it, warns you before you cross it, and shows two kinds of savings:

- **Standard volume savings:** every GB your rules dropped this period, priced at your rate card.
- **Overage penalty avoided:** the extra premium you would have paid on the GB that, without Telemetry Chopper, would have landed past your commitment.

## Before you begin

[Configure vendor pricing](configure-vendor-pricing.md) first. The overage model prices GB with your rate card, or at the default $0.10 per GB if you haven't saved one.

## Set your commitment

1. On the dashboard, click **Pricing** in the header, or go to `/settings/pricing`.
2. Under **Volume commitment**, enter:
   - **Committed volume (GB / month)**, for example `5000`. Commas are accepted.
   - **Overage multiplier**, the overage price as a multiple of your rate card: `1.5` for 150%, `2` for double, or `1` if your contract has no penalty. A trailing `x`, as in `1.5x`, is accepted.
   - **Billing cycle starts on day**, from 1 to 28.
3. Click **Save commitment**.

## Read the billing period section

The dashboard's **This billing period** section shows:

- **Standard volume savings** and **Overage penalty avoided** for the current period.
- **Billable volume**: what your collectors forwarded this period, as a percentage of your commitment, with a status line:

  | Status | Meaning |
  |---|---|
  | ✓ **Within commitment · on pace for N%** | You are under your commitment and projected to stay under it. |
  | ! **N% of commitment used** | You have used at least 90% of your commitment. |
  | ! **On pace for N GB…** | At the current rate, you will exceed your commitment before the period ends. |
  | ▲ **Over commitment since *date*** | You crossed your commitment. The line shows how many GB were billed at the overage rate, and what they cost. |

  When your rules kept you under your commitment, the status line also shows the date you would have crossed it without Telemetry Chopper.

- **Cumulative volume this period**: a chart of **Billable (with Chopper)** and **Without Chopper** volume against your **Commitment** line. Hover over the chart for daily values, or open **Table view** to see them as a table.

The section refreshes with the dashboard every 10 seconds.

## How overage savings are calculated

For the current billing period:

- **Billable volume** is what your collectors forwarded to the vendor.
- **Volume without Chopper** is billable volume plus everything your rules dropped.

**Overage penalty avoided** counts only the overage *premium*, the part of the overage price above your standard rate. The standard rate on those GB is already included in **Standard volume savings**, so nothing is counted twice.

For example, with a 100 GB commitment, a 1.5× multiplier and a price of $0.10 per GB:

| | Volume | Cost |
|---|---|---|
| Without Chopper | 150 GB: 100 GB standard + 50 GB overage | 100 × $0.10 + 50 × $0.15 = **$17.50** |
| With Chopper (billable) | 90 GB, all within commitment | 90 × $0.10 = **$9.00** |

- Standard volume savings: 60 GB dropped × $0.10 = **$6.00**
- Overage penalty avoided: 50 GB kept out of overage × $0.10 × (1.5 − 1) = **$2.50**
- Total: $6.00 + $2.50 = **$8.50**, the full difference between the two bills.

For the complete formulas, see [How savings are calculated](calculations.md#overage).

## Billing periods

A billing period starts on your cycle day at 00:00 UTC and ends just before the same day the following month. For example, a cycle day of 15 gives periods from September 15 to October 14.

Early in a period, the projection is based on very little data. In the first 2% of a period, the dashboard shows volume so far instead of projecting.

## Considerations

- **Prepaid commitments:** if you prepay for your commitment, dropping data while you're below it doesn't save cash that period. **Overage penalty avoided** is the figure that reflects real money.
- **Routed data counts as billable.** Data sent to cold storage with a ROUTE rule is still forwarded by the collector, so it's included in billable volume. If your vendor doesn't bill that destination, your actual billable volume is lower than shown.
- **Mixed prices:** if your signals have different prices, overage GB are priced at a blended rate based on this period's mix of signals.
- There is one commitment per fleet, covering all signals combined. Billing periods use UTC.
- **Upgrading collectors:** collectors released before volume tracking don't report forwarded bytes. The section notes how many heartbeats this period had no volume data. Billable volume is understated until all collectors are upgraded.
- Billing period figures include vendor ingest only. Indexing and cloud egress savings appear in the **Savings breakdown**.

## Frequently asked questions

### Why can Overage penalty avoided be $0 when my rules drop a lot of data?

It's non-zero only when, without your rules, this period's volume would have exceeded your commitment. If you would have stayed under it anyway, there was no penalty to avoid. Your rules' savings appear under **Standard volume savings** instead.

### What multiplier should I enter if my contract has no overage penalty?

Enter `1`. Overage is then billed at your standard rate, and **Overage penalty avoided** is always $0.

### Why is the billing cycle day limited to 28?

So that every month has the day. A cycle day of 31 would be ambiguous in shorter months.
