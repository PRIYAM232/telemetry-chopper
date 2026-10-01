// Per-rule match/drop totals for the dashboard's rule cards (issue #14),
// summed from RuleMetric heartbeat rows over the same window as the savings
// banner, and priced with the same rate card and egress settings so a rule's
// "saves" figure adds up to the fleet total.

import { TargetSignal } from "@/generated/prisma/enums";
import { computeEgressSavings, type EgressConfig } from "@/lib/egress";
import { computeSavings, type RateCard } from "@/lib/pricing";
import { prisma } from "@/lib/prisma";

export type RuleStats = {
  matched: number;
  dropped: number;
  droppedBytes: number;
  unindexed: number;
};

export const EMPTY_RULE_STATS: RuleStats = { matched: 0, dropped: 0, droppedBytes: 0, unindexed: 0 };

// Sums each rule's rows since `since` (all time when null). Rules with no
// rows in the window are absent from the map: they matched nothing.
export async function getRuleStats(
  fleetId: string,
  since: Date | null,
): Promise<Map<string, RuleStats>> {
  const rows = await prisma.ruleMetric.groupBy({
    by: ["ruleId"],
    where: { fleetId, ...(since === null ? {} : { createdAt: { gte: since } }) },
    _sum: { matched: true, dropped: true, droppedBytes: true, unindexed: true },
  });
  return new Map(
    rows.map((r) => [
      r.ruleId,
      {
        matched: r._sum.matched ?? 0,
        dropped: r._sum.dropped ?? 0,
        // BIGINT sums arrive as bigint; Number() is exact below 9 PB.
        droppedBytes: Number(r._sum.droppedBytes ?? 0),
        unindexed: r._sum.unindexed ?? 0,
      },
    ]),
  );
}

// Whether this fleet's collectors have ever reported per-rule counts. Until
// they do (collectors that predate issue #14), an empty map means "unknown",
// not "matched nothing".
export async function fleetReportsRuleStats(fleetId: string): Promise<boolean> {
  const row = await prisma.ruleMetric.findFirst({ where: { fleetId }, select: { id: true } });
  return row !== null;
}

// What this rule's drops and index exclusions saved: vendor ingest on its
// dropped bytes, vendor indexing on its dropped and un-indexed events, plus
// cloud egress on its dropped bytes when enabled.
export function ruleSavingsUSD(
  signal: TargetSignal,
  s: RuleStats,
  card: RateCard,
  egress: EgressConfig,
): number {
  const zero = { traces: 0, logs: 0, metrics: 0 };
  const savings = computeSavings(
    {
      droppedBytes: {
        ...zero,
        [signal === TargetSignal.TRACES ? "traces" : signal === TargetSignal.LOGS ? "logs" : "metrics"]:
          s.droppedBytes,
      },
      droppedEvents: {
        traces: signal === TargetSignal.TRACES ? s.dropped : 0,
        logs: signal === TargetSignal.LOGS ? s.dropped : 0,
      },
      unindexedEvents: {
        traces: signal === TargetSignal.TRACES ? s.unindexed : 0,
        logs: signal === TargetSignal.LOGS ? s.unindexed : 0,
      },
    },
    card,
  );
  return savings.totalUSD + computeEgressSavings(savings.droppedBytes, egress).usd;
}
