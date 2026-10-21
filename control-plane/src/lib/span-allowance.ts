// Monthly span allowances: vendors such as Datadog include some span volume
// with every APM host (150 GB ingested and 1M indexed spans a month, pooled
// across the account) and bill only usage above it, at the end of the month.
// Dropping spans while a month's usage stays inside the allowance saves
// nothing; above it, every dropped GB or span is saved.
//
// So a month's span savings are its bill without Chopper minus its bill with
// it:
//   ingest   = (max(0, forwarded + dropped - included) - max(0, forwarded - included)) x price
//   indexing = the same for indexed spans: all received without Chopper,
//              received - dropped - unindexed with it
// With no allowance (included = 0) this is exactly dropped x price, the
// formula computeSavings uses.
//
// The dashboard's time ranges don't line up with billing months, so each
// month's savings are shared out by where its drops happened: a window gets
// the fraction of the month's dropped bytes (or saved index events) that fell
// inside it. Months still in progress use their usage so far.

import { BYTES_PER_GB, shareOf, type Savings } from "@/lib/pricing";
import { billingPeriod } from "@/lib/overage";
import { prisma } from "@/lib/prisma";

export type SpanAllowance = {
  tracesIncludedGbPerMonth: number;
  tracesIncludedIndexedMillionsPerMonth: number;
};

export function hasSpanAllowance(a: SpanAllowance): boolean {
  return a.tracesIncludedGbPerMonth > 0 || a.tracesIncludedIndexedMillionsPerMonth > 0;
}

// What the vendor bills above an allowance.
function billable(usage: number, included: number): number {
  return Math.max(0, usage - included);
}

/** One billing month's span usage, and the share of it inside a window. */
export type MonthSpanUsage = {
  forwardedBytes: number;
  droppedBytes: number;
  received: number;
  dropped: number;
  unindexed: number;
  // Within the window only.
  windowDroppedBytes: number;
  windowSavedEvents: number; // dropped + unindexed
};

export type SpanPrices = {
  tracesPricePerGb: number;
  tracesIndexPricePerMillion: number;
  // Percent of ingested spans the vendor would index; absent reads as 100.
  tracesIndexedSharePct?: number;
};

/** A month's ingest and indexing savings on spans, scaled to the window's share. */
export function monthSpanSavings(
  m: MonthSpanUsage,
  allowance: SpanAllowance,
  prices: SpanPrices,
): { ingest: number; indexing: number } {
  const includedBytes = allowance.tracesIncludedGbPerMonth * BYTES_PER_GB;
  const ingestMonth =
    ((billable(m.forwardedBytes + m.droppedBytes, includedBytes) - billable(m.forwardedBytes, includedBytes)) /
      BYTES_PER_GB) *
    prices.tracesPricePerGb;

  const includedEvents = allowance.tracesIncludedIndexedMillionsPerMonth * 1_000_000;
  // Only the indexed share of spans counts against the indexing allowance.
  const share = shareOf(prices.tracesIndexedSharePct);
  const indexedWithout = m.received * share;
  const indexedWith = Math.max(0, m.received - m.dropped - m.unindexed) * share;
  const indexingMonth =
    ((billable(indexedWithout, includedEvents) - billable(indexedWith, includedEvents)) / 1_000_000) *
    prices.tracesIndexPricePerMillion;

  const savedEvents = m.dropped + m.unindexed;
  return {
    ingest: m.droppedBytes > 0 ? ingestMonth * (m.windowDroppedBytes / m.droppedBytes) : 0,
    indexing: savedEvents > 0 ? indexingMonth * (m.windowSavedEvents / savedEvents) : 0,
  };
}

/** Replaces the span figures in `savings` and recomputes the totals. */
export function withSpanSavings(savings: Savings, spans: { ingest: number; indexing: number }): Savings {
  const ingest = { ...savings.ingest, traces: spans.ingest };
  ingest.total = ingest.traces + ingest.logs + ingest.metrics;
  const indexing = { ...savings.indexing, traces: spans.indexing };
  indexing.total = indexing.traces + indexing.logs;
  return {
    ...savings,
    ingest,
    indexing,
    totalUSD: ingest.total + indexing.total + savings.series.total,
  };
}

type Sums = {
  _sum: {
    tracesForwardedBytes: bigint | null;
    tracesDroppedBytes: bigint | null;
    tracesReceived: number | null;
    tracesDropped: number | null;
    tracesUnindexed: number | null;
  };
};

function sumSpans(fleetId: string, from: Date, to: Date): Promise<Sums> {
  return prisma.fleetMetric.aggregate({
    where: { fleetId, createdAt: { gte: from, lt: to } },
    _sum: {
      tracesForwardedBytes: true,
      tracesDroppedBytes: true,
      tracesReceived: true,
      tracesDropped: true,
      tracesUnindexed: true,
    },
  });
}

/**
 * Span ingest and indexing savings for the window starting at `since` (all
 * time when null), with the monthly allowance applied per billing month.
 */
export async function getSpanSavings(
  fleetId: string,
  since: Date | null,
  now: Date,
  cycleDay: number,
  allowance: SpanAllowance,
  prices: SpanPrices,
): Promise<{ ingest: number; indexing: number }> {
  let start = since;
  if (start === null) {
    const first = await prisma.fleetMetric.findFirst({
      where: { fleetId },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });
    if (!first) return { ingest: 0, indexing: 0 };
    start = first.createdAt;
  }

  const total = { ingest: 0, indexing: 0 };
  for (let period = billingPeriod(start, cycleDay); period.start < now; period = billingPeriod(period.end, cycleDay)) {
    const windowFrom = start > period.start ? start : period.start;
    const [month, window] = await Promise.all([
      sumSpans(fleetId, period.start, period.end),
      sumSpans(fleetId, windowFrom, period.end),
    ]);
    const s = month._sum;
    const w = window._sum;
    const part = monthSpanSavings(
      {
        forwardedBytes: Number(s.tracesForwardedBytes ?? 0),
        droppedBytes: Number(s.tracesDroppedBytes ?? 0),
        received: s.tracesReceived ?? 0,
        dropped: s.tracesDropped ?? 0,
        unindexed: s.tracesUnindexed ?? 0,
        windowDroppedBytes: Number(w.tracesDroppedBytes ?? 0),
        windowSavedEvents: (w.tracesDropped ?? 0) + (w.tracesUnindexed ?? 0),
      },
      allowance,
      prices,
    );
    total.ingest += part.ingest;
    total.indexing += part.indexing;
  }
  return total;
}
