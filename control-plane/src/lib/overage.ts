// Overage tier modeling: a fleet's committed monthly volume, and what its
// ruleset saved by keeping traffic out of the vendor's overage tier.
//
// For each billing period the collectors report two volumes per signal
// (statsPayload in data-plane/processors/filterprocessor/engine.go):
//   - forwarded bytes: what still reached the vendor — the billable volume;
//   - dropped bytes:   what the ruleset removed.
// Without Chopper the vendor would have billed forwarded + dropped. Pricing
// both against the commitment splits the savings in two:
//   - standard volume savings: every dropped GB at its rate-card price (the
//     Feature 1 figure, scoped to this period);
//   - penalty avoided: the premium ((multiplier - 1) x rate) on the GB that
//     would have landed past the commitment but now don't.
// Their sum is exactly cost(without) - cost(with) for a uniform rate; with
// per-signal rates the overage GB are priced at the period's blended rate.

import { prisma } from "@/lib/prisma";
import { BYTES_PER_GB, type SignalPrices } from "@/lib/pricing";

export type Commitment = {
  committedGbPerMonth: number;
  overageMultiplier: number;
  billingCycleDay: number;
};

export async function getCommitment(fleetId: string): Promise<Commitment | null> {
  const row = await prisma.volumeCommitment.findUnique({ where: { fleetId } });
  if (!row) return null;
  return {
    committedGbPerMonth: row.committedGbPerMonth.toNumber(),
    overageMultiplier: row.overageMultiplier.toNumber(),
    billingCycleDay: row.billingCycleDay,
  };
}

export async function saveCommitment(fleetId: string, c: Commitment): Promise<void> {
  await prisma.volumeCommitment.upsert({
    where: { fleetId },
    create: { fleetId, ...c },
    update: c,
  });
}

export type BillingPeriod = { start: Date; end: Date };

// The UTC billing period containing `now`, starting on `cycleDay` (1-28) of
// a month.
export function billingPeriod(now: Date, cycleDay: number): BillingPeriod {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const thisMonth = new Date(Date.UTC(y, m, cycleDay));
  const start = now >= thisMonth ? thisMonth : new Date(Date.UTC(y, m - 1, cycleDay));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, cycleDay));
  return { start, end };
}

export type SignalBytes = { traces: number; logs: number; metrics: number };

export type DailyVolume = {
  day: Date;
  forwarded: SignalBytes;
  dropped: SignalBytes;
};

export type PeriodVolumes = {
  days: DailyVolume[];
  // Heartbeats in the period that forwarded records but carried no forwarded
  // bytes: collectors that predate volume reporting. Their traffic is
  // missing from the billable total.
  unmeasuredReports: number;
};

type DailyRow = {
  day: Date;
  traces_fwd: bigint;
  logs_fwd: bigint;
  metrics_fwd: bigint;
  traces_drop: bigint;
  logs_drop: bigint;
  metrics_drop: bigint;
  unmeasured: bigint;
};

// One row per UTC day, so a month of 10s heartbeats (hundreds of thousands
// of rows per collector) arrives as ~31 sums.
export async function getPeriodVolumes(
  fleetId: string,
  period: BillingPeriod,
): Promise<PeriodVolumes> {
  // createdAt is TIMESTAMP(3) holding UTC; casting the ISO strings to
  // timestamp (without time zone) keeps the comparison in UTC regardless of
  // the database session's TimeZone.
  const rows = await prisma.$queryRaw<DailyRow[]>`
    SELECT date_trunc('day', "createdAt") AS day,
           COALESCE(SUM("tracesForwardedBytes"), 0)::bigint  AS traces_fwd,
           COALESCE(SUM("logsForwardedBytes"), 0)::bigint    AS logs_fwd,
           COALESCE(SUM("metricsForwardedBytes"), 0)::bigint AS metrics_fwd,
           COALESCE(SUM("tracesDroppedBytes"), 0)::bigint    AS traces_drop,
           COALESCE(SUM("logsDroppedBytes"), 0)::bigint      AS logs_drop,
           COALESCE(SUM("metricsDroppedBytes"), 0)::bigint   AS metrics_drop,
           COUNT(*) FILTER (
             WHERE ("tracesReceived" - "tracesDropped")
                 + ("logsReceived" - "logsDropped")
                 + ("metricsReceived" - "metricsDropped") > 0
               AND "tracesForwardedBytes" + "logsForwardedBytes" + "metricsForwardedBytes" = 0
           )::bigint AS unmeasured
    FROM "FleetMetric"
    WHERE "fleetId" = ${fleetId}::uuid
      AND "createdAt" >= ${period.start.toISOString()}::timestamp
      AND "createdAt" <  ${period.end.toISOString()}::timestamp
    GROUP BY 1
    ORDER BY 1`;

  let unmeasuredReports = 0;
  const days = rows.map((r) => {
    unmeasuredReports += Number(r.unmeasured);
    return {
      // date_trunc of a timestamp comes back as a Date read in UTC.
      day: r.day,
      forwarded: {
        traces: Number(r.traces_fwd),
        logs: Number(r.logs_fwd),
        metrics: Number(r.metrics_fwd),
      },
      dropped: {
        traces: Number(r.traces_drop),
        logs: Number(r.logs_drop),
        metrics: Number(r.metrics_drop),
      },
    };
  });
  return { days, unmeasuredReports };
}

export type CumulativePoint = {
  day: Date;
  billableBytes: number;
  withoutChopperBytes: number;
};

export type OverageModel = {
  committedBytes: number;
  multiplier: number;
  billableBytes: number;
  withoutChopperBytes: number;
  standardSavingsUSD: number;
  avoidedOverageBytes: number;
  penaltyAvoidedUSD: number;
  // Overage actually incurred this period, despite the ruleset.
  overageBytes: number;
  overageCostUSD: number;
  // First day cumulative volume passed the commitment, with and without the
  // ruleset; null if it hasn't.
  billableCrossedOn: Date | null;
  withoutChopperCrossedOn: Date | null;
  // Billable volume at period end if the period-to-date pace holds.
  projectedBillableBytes: number;
  series: CumulativePoint[];
};

function sum(b: SignalBytes): number {
  return b.traces + b.logs + b.metrics;
}

// Price of `bytes` at the rate mix of `mix` (per-signal volumes).
function blendedPricePerGb(mix: SignalBytes, prices: SignalPrices): number {
  const total = sum(mix);
  if (total === 0) return 0;
  return (
    (mix.traces * prices.tracesPricePerGb +
      mix.logs * prices.logsPricePerGb +
      mix.metrics * prices.metricsPricePerGb) /
    total
  );
}

export function modelOverage(
  days: DailyVolume[],
  commitment: Commitment,
  prices: SignalPrices,
  period: BillingPeriod,
  now: Date,
): OverageModel {
  const C = commitment.committedGbPerMonth * BYTES_PER_GB;
  const m = commitment.overageMultiplier;

  const fwd: SignalBytes = { traces: 0, logs: 0, metrics: 0 };
  const drop: SignalBytes = { traces: 0, logs: 0, metrics: 0 };
  const series: CumulativePoint[] = [];
  let billableCrossedOn: Date | null = null;
  let withoutChopperCrossedOn: Date | null = null;

  for (const d of days) {
    for (const k of ["traces", "logs", "metrics"] as const) {
      fwd[k] += d.forwarded[k];
      drop[k] += d.dropped[k];
    }
    const F = sum(fwd);
    const W = F + sum(drop);
    if (billableCrossedOn === null && F > C) billableCrossedOn = d.day;
    if (withoutChopperCrossedOn === null && W > C) withoutChopperCrossedOn = d.day;
    series.push({ day: d.day, billableBytes: F, withoutChopperBytes: W });
  }

  const F = sum(fwd);
  const W = F + sum(drop);
  const without: SignalBytes = {
    traces: fwd.traces + drop.traces,
    logs: fwd.logs + drop.logs,
    metrics: fwd.metrics + drop.metrics,
  };

  const standardSavingsUSD =
    (drop.traces / BYTES_PER_GB) * prices.tracesPricePerGb +
    (drop.logs / BYTES_PER_GB) * prices.logsPricePerGb +
    (drop.metrics / BYTES_PER_GB) * prices.metricsPricePerGb;

  const overageBytes = Math.max(0, F - C);
  const avoidedOverageBytes = Math.max(0, W - C) - overageBytes;
  const penaltyAvoidedUSD =
    (avoidedOverageBytes / BYTES_PER_GB) * blendedPricePerGb(without, prices) * (m - 1);
  const overageCostUSD =
    (overageBytes / BYTES_PER_GB) * blendedPricePerGb(fwd, prices) * m;

  const elapsed = Math.min(
    1,
    Math.max(0, (now.getTime() - period.start.getTime()) / (period.end.getTime() - period.start.getTime())),
  );
  // Too early in the period to extrapolate meaningfully: echo the actuals.
  const projectedBillableBytes = elapsed > 0.02 ? F / elapsed : F;

  return {
    committedBytes: C,
    multiplier: m,
    billableBytes: F,
    withoutChopperBytes: W,
    standardSavingsUSD,
    avoidedOverageBytes,
    penaltyAvoidedUSD,
    overageBytes,
    overageCostUSD,
    billableCrossedOn,
    withoutChopperCrossedOn,
    projectedBillableBytes,
    series,
  };
}
