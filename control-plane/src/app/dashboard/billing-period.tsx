// The dashboard's "This billing period" section: forwarded volume against
// the fleet's committed tier, and the savings split into standard volume
// savings and overage penalty avoided (see src/lib/overage.ts for the math).
// Server-rendered; refreshes with the page's 10s AutoRefresh.

import Link from "next/link";
import { formatBytes, formatUSD } from "@/lib/format";
import { billingPeriod, getCommitment, getPeriodVolumes, modelOverage } from "@/lib/overage";
import type { RateCard } from "@/lib/pricing";
import { OverageChart, type ChartPoint } from "./overage-chart";

const DAY_MS = 86_400_000;

const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

// Past this share of the commitment the meter turns amber: close enough
// that one bad day can tip the period into overage.
const WARN_FRACTION = 0.9;

export async function BillingPeriodSection({
  fleetId,
  rateCard,
  nowMs,
}: {
  fleetId: string;
  rateCard: RateCard;
  nowMs: number;
}) {
  const commitment = await getCommitment(fleetId);

  if (!commitment) {
    return (
      <section aria-label="Billing period" className="mt-10">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">This billing period</h2>
        <div className="mt-4 rounded-xl border border-dashed border-zinc-300 p-5 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
          Add your monthly committed volume and overage multiplier to track this period
          against your tier and see the overage penalties your rules prevent.{" "}
          <Link
            href="/settings/pricing"
            className="font-medium text-zinc-900 underline decoration-zinc-300 underline-offset-2 dark:text-zinc-100 dark:decoration-zinc-700"
          >
            Set your commitment
          </Link>
        </div>
      </section>
    );
  }

  const now = new Date(nowMs);
  const period = billingPeriod(now, commitment.billingCycleDay);
  const { days, unmeasuredReports } = await getPeriodVolumes(fleetId, period);
  const model = modelOverage(days, commitment, rateCard, period, now);

  // Each daily sum is cumulative through the end of that day (or now, for
  // today); the series starts from zero at the period start.
  const points: ChartPoint[] = [
    { t: period.start.getTime(), day: null, billable: 0, without: 0 },
    ...model.series.map((p) => ({
      t: Math.min(p.day.getTime() + DAY_MS, nowMs),
      day: p.day.getTime(),
      billable: p.billableBytes,
      without: p.withoutChopperBytes,
    })),
  ];

  const usedFraction = model.billableBytes / model.committedBytes;
  const projectedFraction = model.projectedBillableBytes / model.committedBytes;
  const multiplierLabel = `${model.multiplier}×`;
  const lastDay = new Date(period.end.getTime() - DAY_MS);

  let status: { icon: string; label: string; tone: string };
  if (model.billableCrossedOn) {
    status = {
      icon: "▲",
      label: `Over commitment since ${dayFmt.format(model.billableCrossedOn)} · ${formatBytes(model.overageBytes)} billed at ${multiplierLabel} (${formatUSD(model.overageCostUSD)})`,
      tone: "text-rose-700 dark:text-rose-400",
    };
  } else if (usedFraction >= WARN_FRACTION || projectedFraction > 1) {
    status = {
      icon: "!",
      label:
        projectedFraction > 1
          ? `On pace for ${formatBytes(model.projectedBillableBytes)} by ${dayFmt.format(lastDay)} — ${((projectedFraction - 1) * 100).toFixed(0)}% into the ${multiplierLabel} tier`
          : `${(usedFraction * 100).toFixed(0)}% of commitment used`,
      tone: "text-amber-700 dark:text-amber-400",
    };
  } else {
    status = {
      icon: "✓",
      label: `Within commitment · on pace for ${(projectedFraction * 100).toFixed(0)}% by ${dayFmt.format(lastDay)}`,
      tone: "text-emerald-700 dark:text-emerald-400",
    };
  }

  const meterFill = model.billableCrossedOn
    ? "bg-rose-500"
    : usedFraction >= WARN_FRACTION || projectedFraction > 1
      ? "bg-amber-500"
      : "bg-[#2a78d6] dark:bg-[#3987e5]";

  return (
    <section aria-label="Billing period" className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          This billing period
          <span className="ml-2 text-sm font-normal text-zinc-500 dark:text-zinc-400">
            {dayFmt.format(period.start)} – {dayFmt.format(lastDay)} (UTC) ·{" "}
            {formatBytes(model.committedBytes)} committed, {multiplierLabel} overage
          </span>
        </h2>
        <Link
          href="/settings/pricing"
          className="text-sm text-zinc-500 underline decoration-zinc-300 underline-offset-2 hover:text-zinc-900 dark:text-zinc-400 dark:decoration-zinc-700 dark:hover:text-zinc-100"
        >
          Edit commitment
        </Link>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Standard volume savings</p>
          <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-emerald-600 dark:text-emerald-400">
            {formatUSD(model.standardSavingsUSD)}
          </p>
          <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
            {formatBytes(model.withoutChopperBytes - model.billableBytes)} dropped this period at your
            rate card
          </p>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Overage penalty avoided</p>
          <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-emerald-600 dark:text-emerald-400">
            {formatUSD(model.penaltyAvoidedUSD)}
          </p>
          <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
            {model.avoidedOverageBytes > 0
              ? `${formatBytes(model.avoidedOverageBytes)} kept out of the ${multiplierLabel} tier${
                  model.withoutChopperCrossedOn
                    ? ` · without Chopper you'd have crossed on ${dayFmt.format(model.withoutChopperCrossedOn)}`
                    : ""
                }`
              : model.multiplier === 1
                ? "No overage premium at a 1× multiplier"
                : "Traffic hasn't reached the overage tier this period"}
          </p>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Billable volume</p>
          <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-zinc-900 dark:text-zinc-50">
            {(usedFraction * 100).toFixed(1)}%
            <span className="ml-2 text-sm font-normal text-zinc-500 dark:text-zinc-400">
              {formatBytes(model.billableBytes)} of {formatBytes(model.committedBytes)}
            </span>
          </p>
          <div
            className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#cde2fb] dark:bg-[#184f95]/40"
            role="meter"
            aria-label="Billable volume against commitment"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(Math.min(usedFraction, 1) * 100)}
          >
            <div className={`h-full rounded-full ${meterFill}`} style={{ width: `${Math.min(usedFraction, 1) * 100}%` }} />
          </div>
          <p className={`mt-2 flex gap-1.5 text-xs ${status.tone}`}>
            <span aria-hidden="true">{status.icon}</span>
            {status.label}
          </p>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
        <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">Cumulative volume this period</p>
        <OverageChart
          points={points}
          committedBytes={model.committedBytes}
          periodStart={period.start.getTime()}
          periodEnd={period.end.getTime()}
        />
        {unmeasuredReports > 0 && (
          <p
            className="mt-3 text-xs text-amber-600 dark:text-amber-400"
            title="These heartbeats came from collectors that report drop counts but not forwarded volume. Upgrade the collectors so all traffic counts toward the commitment."
          >
            {unmeasuredReports.toLocaleString("en-US")}{" "}
            {unmeasuredReports === 1 ? "heartbeat" : "heartbeats"} this period carried no volume
            data — billable volume is understated until every collector is upgraded.
          </p>
        )}
      </div>
    </section>
  );
}
