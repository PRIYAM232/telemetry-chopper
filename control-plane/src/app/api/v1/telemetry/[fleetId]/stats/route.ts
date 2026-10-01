// POST /api/v1/telemetry/:fleetId/stats
//
// Heartbeat sink for otelcol-chopper data planes. Every stats interval each
// collector reports how many spans and log records it received and dropped
// since its last successful report; one FleetMetric row is inserted per
// report. Auth is the same fleet-scoped bearer token as the policy pull
// (src/lib/fleet-auth.ts).
//
// Request body (produced by the stats loop in
// data-plane/processors/filterprocessor/engine.go):
//
//   {
//     "traces_received":  int64, "traces_dropped":  int64,
//     "logs_received":    int64, "logs_dropped":    int64,
//     "metrics_received": int64, "metrics_dropped": int64,
//     "traces_dropped_bytes": int64, "logs_dropped_bytes": int64,
//     "metrics_dropped_bytes": int64,
//     "traces_forwarded_bytes": int64, "logs_forwarded_bytes": int64,
//     "metrics_forwarded_bytes": int64,
//     "traces_unindexed": int64, "logs_unindexed": int64,
//     "rules": [ { "rule_id": uuid, "matched": int64, "dropped": int64,
//                  "dropped_bytes": int64, "unindexed": int64 }, ... ]
//   }
//
// "rules" (issue #14) attributes the interval to individual rules; the
// collector sends only rules with activity and omits the key when none had
// any. Each entry becomes a RuleMetric row in the same transaction as the
// FleetMetric row. Entries for rules this fleet doesn't own — typically a rule
// deleted between the collector's last sync and this report — are skipped,
// not rejected, so a routine race can't wedge the heartbeat in a 400 loop.
//
// Phase-4 collectors still in the field send { "received", "dropped" }; those
// are accepted and recorded as trace counts so a fleet can upgrade its
// control plane before its collectors. Pre-Phase-6 collectors simply omit the
// metrics_* keys, which read as 0 below; collectors that predate byte
// accounting omit the *_dropped_bytes and *_forwarded_bytes keys the same
// way, so their drops are counted but contribute nothing to the priced
// savings, and their traffic is invisible to the overage model. The
// *_unindexed counts (records forwarded but opted out of indexing by
// EXCLUDE_INDEX rules) read as 0 when absent, like every other count.
//
// An all-zero body is still a valid heartbeat — it proves the collector is
// alive — so it is stored, not skipped.

import { NextRequest, NextResponse } from "next/server";
import { authenticateFleet } from "@/lib/fleet-auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// FleetMetric counters are Postgres INT4. The collector accumulates across
// failed reports, so after a very long control-plane outage on a very hot
// fleet the delta could exceed int32; clamp instead of rejecting so one
// oversized report can't wedge the heartbeat into a permanent 400 loop.
const INT4_MAX = 2_147_483_647;

// A count field may be absent (older collector, or a signal the pipeline
// doesn't carry) — that reads as 0. Present-but-malformed is a client bug and
// stays a 400.
function asCount(value: unknown): number | null {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return Math.min(value, INT4_MAX);
}

// Byte fields land in BIGINT columns, so no int32 clamp — but JSON numbers
// past 2^53 have already lost precision in request.json(). Clamp there
// instead (9 PB in one interval is not a real report).
function asBytes(value: unknown): bigint | null {
  if (value === undefined) return BigInt(0);
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return BigInt(Math.min(value, Number.MAX_SAFE_INTEGER));
}

// Postgres rejects a malformed UUID with an error, not a non-match; filter
// them out up front like any other unknown rule ID.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A ruleset is bounded by what the policy endpoint serves (4 MiB on the
// collector side); anything past this is not a real collector.
const MAX_RULE_ENTRIES = 10_000;

type RuleEntry = {
  ruleId: string;
  matched: number;
  dropped: number;
  droppedBytes: bigint;
  unindexed: number;
};

// Parses the optional "rules" array. Returns null when it is present but
// malformed (a client bug, so a 400 like any other bad count).
function parseRuleEntries(value: unknown): RuleEntry[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_RULE_ENTRIES) return null;
  const entries: RuleEntry[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return null;
    const e = raw as Record<string, unknown>;
    if (typeof e.rule_id !== "string") return null;
    const matched = asCount(e.matched);
    const dropped = asCount(e.dropped);
    const unindexed = asCount(e.unindexed);
    const droppedBytes = asBytes(e.dropped_bytes);
    if (matched === null || dropped === null || unindexed === null || droppedBytes === null) {
      return null;
    }
    entries.push({ ruleId: e.rule_id, matched, dropped, droppedBytes, unindexed });
  }
  return entries;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ fleetId: string }> },
): Promise<NextResponse> {
  const { fleetId } = await params;

  const auth = await authenticateFleet(request, fleetId);
  if (!auth.ok) {
    return auth.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "request body must be JSON" },
      { status: 400 },
    );
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const tracesReceived = asCount(payload.traces_received ?? payload.received);
  const tracesDropped = asCount(payload.traces_dropped ?? payload.dropped);
  const logsReceived = asCount(payload.logs_received);
  const logsDropped = asCount(payload.logs_dropped);
  const metricsReceived = asCount(payload.metrics_received);
  const metricsDropped = asCount(payload.metrics_dropped);
  const tracesUnindexed = asCount(payload.traces_unindexed);
  const logsUnindexed = asCount(payload.logs_unindexed);
  const tracesDroppedBytes = asBytes(payload.traces_dropped_bytes);
  const logsDroppedBytes = asBytes(payload.logs_dropped_bytes);
  const metricsDroppedBytes = asBytes(payload.metrics_dropped_bytes);
  const tracesForwardedBytes = asBytes(payload.traces_forwarded_bytes);
  const logsForwardedBytes = asBytes(payload.logs_forwarded_bytes);
  const metricsForwardedBytes = asBytes(payload.metrics_forwarded_bytes);
  if (
    tracesReceived === null ||
    tracesDropped === null ||
    logsReceived === null ||
    logsDropped === null ||
    metricsReceived === null ||
    metricsDropped === null ||
    tracesUnindexed === null ||
    logsUnindexed === null ||
    tracesDroppedBytes === null ||
    logsDroppedBytes === null ||
    metricsDroppedBytes === null ||
    tracesForwardedBytes === null ||
    logsForwardedBytes === null ||
    metricsForwardedBytes === null
  ) {
    return NextResponse.json(
      { error: "telemetry counts must be non-negative integers" },
      { status: 400 },
    );
  }

  const ruleEntries = parseRuleEntries(payload.rules);
  if (ruleEntries === null) {
    return NextResponse.json(
      { error: "rules must be an array of { rule_id, matched, dropped, dropped_bytes, unindexed } with non-negative integer counts" },
      { status: 400 },
    );
  }

  // Keep only rules this fleet owns. Scoping by fleet also stops one
  // fleet's key from writing stats against another fleet's rules.
  const candidateIds = [...new Set(ruleEntries.map((e) => e.ruleId).filter((id) => UUID_RE.test(id)))];
  const owned =
    candidateIds.length === 0
      ? new Set<string>()
      : new Set(
          (
            await prisma.policyRule.findMany({
              where: { fleetId: auth.fleetId, id: { in: candidateIds } },
              select: { id: true },
            })
          ).map((r) => r.id),
        );
  const ruleRows = ruleEntries
    .filter((e) => owned.has(e.ruleId))
    .map((e) => ({ fleetId: auth.fleetId, ...e }));

  const fleetRow = prisma.fleetMetric.create({
    data: {
      fleetId: auth.fleetId,
      tracesReceived,
      tracesDropped,
      logsReceived,
      logsDropped,
      metricsReceived,
      metricsDropped,
      tracesUnindexed,
      logsUnindexed,
      tracesDroppedBytes,
      logsDroppedBytes,
      metricsDroppedBytes,
      tracesForwardedBytes,
      logsForwardedBytes,
      metricsForwardedBytes,
    },
  });
  await (ruleRows.length > 0
    ? prisma.$transaction([fleetRow, prisma.ruleMetric.createMany({ data: ruleRows })])
    : fleetRow);

  return new NextResponse(null, { status: 204 });
}
