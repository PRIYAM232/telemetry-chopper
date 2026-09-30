// /dashboard — the Telemetry Chopper operator console.
//
// Fully server-rendered: data is queried directly with Prisma, mutations go
// through Server Actions (./actions.ts) that revalidate this path, and a tiny
// client island (AutoRefresh) refetches the RSC payload every 10s so the
// savings banner tracks the collectors' heartbeat cadence in near real time.

import type { Metadata } from "next";
import Link from "next/link";
import { PolicyAction, TargetSignal, ConditionOp } from "@/generated/prisma/enums";
import type { PolicyRuleModel } from "@/generated/prisma/models";
import { formatUSD } from "@/lib/format";
import { computeSavings, getRateCard, rateCardLabel } from "@/lib/pricing";
import { prisma } from "@/lib/prisma";
import { re2SyntaxError } from "@/lib/re2";
import { deleteRule, toggleRuleActive } from "./actions";
import { AutoRefresh } from "./auto-refresh";
import { BillingPeriodSection } from "./billing-period";
import { SavingsBreakdown } from "./savings-breakdown";
import { CreateRuleForm } from "./create-rule-form";
import { SubmitButton } from "./pending";

// This page reads live operational data on every request; never prerender it.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Telemetry Chopper — Fleet Dashboard",
  description: "Live telemetry savings and policy rules for your collector fleet.",
};

// A collector heartbeats every ~10s; three missed beats means offline.
const HEARTBEAT_STALE_MS = 30_000;

const integerFmt = new Intl.NumberFormat("en-US");
const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export default async function DashboardPage() {
  const fleet = await prisma.collectorFleet.findFirst({
    orderBy: { createdAt: "asc" },
    include: { rules: { orderBy: { createdAt: "asc" } } },
  });

  if (!fleet) {
    return (
      <main className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-md rounded-xl border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-950">
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            No collector fleet found
          </h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            Seed the development fleet first:{" "}
            <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs dark:bg-zinc-900">
              npx prisma db seed
            </code>
          </p>
        </div>
      </main>
    );
  }

  const [totals, unsized, lastMetric, rateCard] = await Promise.all([
    prisma.fleetMetric.aggregate({
      where: { fleetId: fleet.id },
      _sum: {
        tracesReceived: true,
        tracesDropped: true,
        logsReceived: true,
        logsDropped: true,
        metricsReceived: true,
        metricsDropped: true,
        tracesDroppedBytes: true,
        logsDroppedBytes: true,
        metricsDroppedBytes: true,
        tracesUnindexed: true,
        logsUnindexed: true,
      },
    }),
    // Heartbeats from collectors that predate byte accounting carry drop
    // counts but no sizes, so they can't be priced — count them to say so.
    prisma.fleetMetric.aggregate({
      where: {
        fleetId: fleet.id,
        tracesDroppedBytes: 0,
        logsDroppedBytes: 0,
        metricsDroppedBytes: 0,
      },
      _sum: { tracesDropped: true, logsDropped: true, metricsDropped: true },
    }),
    prisma.fleetMetric.findFirst({
      where: { fleetId: fleet.id },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    getRateCard(fleet.id),
  ]);

  const tracesReceived = totals._sum.tracesReceived ?? 0;
  const tracesDropped = totals._sum.tracesDropped ?? 0;
  const logsReceived = totals._sum.logsReceived ?? 0;
  const logsDropped = totals._sum.logsDropped ?? 0;
  const metricsReceived = totals._sum.metricsReceived ?? 0;
  const metricsDropped = totals._sum.metricsDropped ?? 0;

  // The banner reports the fleet total across signals — combined savings
  // include metrics as of Phase 6; the per-signal split lives in each card's
  // hint line.
  const received = tracesReceived + logsReceived + metricsReceived;
  const dropped = tracesDropped + logsDropped + metricsDropped;
  const reductionPct = received > 0 ? (dropped / received) * 100 : 0;
  // BIGINT sums arrive as bigint; Number() is exact below 9 PB.
  const savings = computeSavings(
    {
      droppedBytes: {
        traces: Number(totals._sum.tracesDroppedBytes ?? 0),
        logs: Number(totals._sum.logsDroppedBytes ?? 0),
        metrics: Number(totals._sum.metricsDroppedBytes ?? 0),
      },
      droppedEvents: { traces: tracesDropped, logs: logsDropped },
      unindexedEvents: {
        traces: totals._sum.tracesUnindexed ?? 0,
        logs: totals._sum.logsUnindexed ?? 0,
      },
    },
    rateCard,
  );
  const unsizedDrops =
    (unsized._sum.tracesDropped ?? 0) +
    (unsized._sum.logsDropped ?? 0) +
    (unsized._sum.metricsDropped ?? 0);

  // This server component is force-dynamic: each render is one request, so
  // request-time "now" is stable for the lifetime of the response and the
  // AutoRefresh island re-requests every 10s to keep the age honest.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const heartbeatAgeMs = lastMetric
    ? nowMs - lastMetric.createdAt.getTime()
    : null;
  const collectorOnline =
    heartbeatAgeMs !== null && heartbeatAgeMs < HEARTBEAT_STALE_MS;

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
      <AutoRefresh intervalMs={10_000} />

      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Telemetry Chopper
            <span className="ml-2 text-base font-normal text-zinc-500 dark:text-zinc-400">
              observability cost control
            </span>
          </h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Fleet <span className="font-medium text-zinc-900 dark:text-zinc-200">{fleet.name}</span>
            <span className="mx-1.5 text-zinc-300 dark:text-zinc-700">·</span>
            <code className="font-mono text-xs">{fleet.id}</code>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/settings/pricing"
          className="rounded-full border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          Pricing
        </Link>
        <div
          className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium ${
            collectorOnline
              ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-400"
              : "border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
          }`}
        >
          <span
            className={`h-2 w-2 rounded-full ${
              collectorOnline ? "animate-pulse bg-emerald-500" : "bg-zinc-400"
            }`}
          />
          {collectorOnline
            ? "Collector online"
            : heartbeatAgeMs !== null
              ? `Last heartbeat ${Math.round(heartbeatAgeMs / 1000)}s ago`
              : "No heartbeat yet"}
        </div>
        </div>
      </header>

      {/* Metric banner */}
      <section aria-label="Fleet savings" className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Telemetry processed"
          value={integerFmt.format(received)}
          hint={`${integerFmt.format(tracesReceived)} spans · ${integerFmt.format(logsReceived)} logs · ${integerFmt.format(metricsReceived)} metrics, all time`}
        />
        <StatCard
          label="Telemetry dropped"
          value={integerFmt.format(dropped)}
          hint={`${integerFmt.format(tracesDropped)} spans · ${integerFmt.format(logsDropped)} logs · ${integerFmt.format(metricsDropped)} metrics filtered`}
          accent="text-rose-600 dark:text-rose-400"
        />
        <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Data reduction</p>
          <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-zinc-900 dark:text-zinc-50">
            {reductionPct.toFixed(1)}%
          </p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-900">
            <div
              className="h-full rounded-full bg-emerald-500"
              style={{ width: `${Math.min(reductionPct, 100)}%` }}
            />
          </div>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Estimated savings</p>
          <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-emerald-600 dark:text-emerald-400">
            {formatUSD(savings.totalUSD)}
          </p>
          <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
            Ingest + indexing, all time × {rateCardLabel(rateCard)}{" "}
            {rateCard.vendor === null ? `$${rateCard.logsPricePerGb.toFixed(2)}/GB` : "rate card"} ·{" "}
            <Link
              href="/settings/pricing"
              className="underline decoration-zinc-300 underline-offset-2 hover:text-zinc-700 dark:decoration-zinc-700 dark:hover:text-zinc-300"
            >
              {rateCard.vendor === null ? "set your rates" : "edit"}
            </Link>
          </p>
          {unsizedDrops > 0 && (
            <p
              className="mt-1 text-xs text-amber-600 dark:text-amber-400"
              title="These heartbeats came from collectors that report drop counts but not bytes. Upgrade the collectors to price their drops."
            >
              {integerFmt.format(unsizedDrops)} earlier drops unpriced (no byte data)
            </p>
          )}
        </div>
      </section>

      <SavingsBreakdown savings={savings} rateCard={rateCard} />

      <BillingPeriodSection fleetId={fleet.id} rateCard={rateCard} nowMs={nowMs} />

      {/* Rules */}
      <section aria-label="Policy rules" className="mt-10">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            Policy rules
            <span className="ml-2 text-sm font-normal text-zinc-500 dark:text-zinc-400">
              {fleet.rules.length} total · synced by collectors every poll
            </span>
          </h2>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Create form */}
          <div className="rounded-xl border border-dashed border-zinc-300 bg-zinc-50/50 p-5 dark:border-zinc-700 dark:bg-zinc-900/40">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">New rule</h3>
            <CreateRuleForm fleetId={fleet.id} />
          </div>

          {/* Rule grid */}
          <div className="flex flex-col gap-3 lg:col-span-2">
            {fleet.rules.length === 0 ? (
              <div className="flex flex-1 items-center justify-center rounded-xl border border-zinc-200 p-8 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                No rules yet — every span passes through untouched.
              </div>
            ) : (
              fleet.rules.map((rule) => <RuleCard key={rule.id} rule={rule} />)
            )}
          </div>
        </div>
      </section>
    </main>
  );
}

function StatCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint: string;
  accent?: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <p className="text-sm text-zinc-500 dark:text-zinc-400">{label}</p>
      <p
        className={`mt-1 text-3xl font-semibold tabular-nums tracking-tight ${
          accent ?? "text-zinc-900 dark:text-zinc-50"
        }`}
      >
        {value}
      </p>
      <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">{hint}</p>
    </div>
  );
}

const actionBadgeStyles: Record<string, string> = {
  [PolicyAction.DROP]:
    "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950 dark:text-rose-400 dark:border-rose-900",
  [PolicyAction.SAMPLE]:
    "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-900",
  [PolicyAction.REDACT]:
    "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950 dark:text-violet-400 dark:border-violet-900",
  [PolicyAction.ROUTE]:
    "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950 dark:text-sky-400 dark:border-sky-900",
  [PolicyAction.THROTTLE]:
    "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950 dark:text-orange-400 dark:border-orange-900",
  [PolicyAction.EXCLUDE_INDEX]:
    "bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950 dark:text-cyan-400 dark:border-cyan-900",
};

// Mirrors ruleAppliesTraces()/ruleAppliesLogs()/ruleAppliesMetrics() in the
// Go data plane (data-plane/processors/filterprocessor/rules.go): TRACES
// rules enforce DROP, REDACT, rate-carrying SAMPLE, and destination-carrying
// ROUTE; LOGS rules enforce DROP, REDACT, and ROUTE (log sampling still
// undefined); METRICS rules enforce DROP and ROUTE as of Phase 7. THROTTLE
// (Phase 8) is enforced on every signal, but only with a positive rate.
// EXCLUDE_INDEX is enforced on TRACES and LOGS (metrics aren't indexed).
// Anything else (METRICS REDACT/SAMPLE, LOGS SAMPLE, SAMPLE without a rate,
// ROUTE without a destination, rate-less THROTTLE) is stored and synced, but
// collectors skip it — surface that so operators aren't misled.
function ruleEnforced(rule: PolicyRuleModel): boolean {
  if (rule.actionType === PolicyAction.ROUTE) {
    return rule.targetDestination !== null;
  }
  if (rule.actionType === PolicyAction.THROTTLE) {
    return rule.throttleRate !== null && rule.throttleRate > 0;
  }
  switch (rule.targetSignal) {
    case TargetSignal.TRACES:
      return (
        rule.actionType === PolicyAction.DROP ||
        rule.actionType === PolicyAction.REDACT ||
        rule.actionType === PolicyAction.EXCLUDE_INDEX ||
        (rule.actionType === PolicyAction.SAMPLE && rule.sampleRate !== null)
      );
    case TargetSignal.LOGS:
      return (
        rule.actionType === PolicyAction.DROP ||
        rule.actionType === PolicyAction.REDACT ||
        rule.actionType === PolicyAction.EXCLUDE_INDEX
      );
    case TargetSignal.METRICS:
      return rule.actionType === PolicyAction.DROP;
    default:
      return false;
  }
}

function RuleCard({ rule }: { rule: PolicyRuleModel }) {
  // createRule rejects these now, but rules saved before that check (or
  // written straight to the database) can still hold a pattern the
  // collector's RE2 won't compile. The collector skips them, so say so.
  const regexError =
    rule.conditionOp === ConditionOp.REGEX_MATCH ? re2SyntaxError(rule.conditionValue) : null;

  return (
    <div
      className={`rounded-xl border bg-white p-4 transition-opacity dark:bg-zinc-950 ${
        rule.isActive
          ? "border-zinc-200 dark:border-zinc-800"
          : "border-zinc-200 opacity-60 dark:border-zinc-800"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`shrink-0 rounded-md border px-2 py-0.5 text-xs font-semibold ${
              actionBadgeStyles[rule.actionType] ?? actionBadgeStyles[PolicyAction.REDACT]
            }`}
          >
            {rule.actionType}
            {rule.actionType === PolicyAction.SAMPLE && rule.sampleRate !== null
              ? ` ${Math.round(rule.sampleRate * 100)}%`
              : ""}
          </span>
          {rule.actionType === PolicyAction.ROUTE && rule.targetDestination !== null && (
            <span
              className="shrink-0 rounded-md border border-sky-200 bg-sky-50 px-2 py-0.5 font-mono text-xs text-sky-700 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-400"
              title="Matching telemetry is tagged chopper.routing.destination and forked to this exporter by the collector's routing connector."
            >
              → {rule.targetDestination}
            </span>
          )}
          {rule.actionType === PolicyAction.EXCLUDE_INDEX && (
            <span
              className="shrink-0 rounded-md border border-cyan-200 bg-cyan-50 px-2 py-0.5 font-mono text-xs text-cyan-700 dark:border-cyan-900 dark:bg-cyan-950 dark:text-cyan-400"
              title="Matching telemetry is forwarded (ingest still billed) but stamped chopper.index=false. Your vendor's index exclusion or retention filter on that attribute keeps it out of the paid index."
            >
              chopper.index=false
            </span>
          )}
          {rule.actionType === PolicyAction.THROTTLE && rule.throttleRate !== null && (
            <span
              className="shrink-0 rounded-md border border-orange-200 bg-orange-50 px-2 py-0.5 font-mono text-xs text-orange-700 dark:border-orange-900 dark:bg-orange-950 dark:text-orange-400"
              title="Token-bucket rate limit enforced per collector: matching telemetry above the rate is dropped, traffic under it passes untouched. Grouped buckets give each attribute value its own budget."
            >
              Limit: {rule.throttleRate}/s{" "}
              {rule.throttleGroupBy !== null ? `per ${rule.throttleGroupBy}` : "global"}
            </span>
          )}
          <h3 className="truncate font-medium text-zinc-900 dark:text-zinc-100">{rule.name}</h3>
          {!rule.isActive && (
            <span className="shrink-0 rounded-md bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
              paused
            </span>
          )}
          {rule.isActive && !ruleEnforced(rule) && (
            <span
              className="shrink-0 rounded-md bg-amber-50 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-400"
              title="The data plane doesn't execute this rule type yet; it is stored and synced only."
            >
              not enforced yet
            </span>
          )}
          {regexError !== null && (
            <span
              className="shrink-0 rounded-md bg-rose-50 px-2 py-0.5 text-xs text-rose-700 dark:bg-rose-950 dark:text-rose-400"
              title={`Collectors skip this rule: the pattern isn't valid RE2. ${regexError}`}
            >
              invalid regex · not enforced
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <form action={toggleRuleActive}>
            <input type="hidden" name="ruleId" value={rule.id} />
            <SubmitButton className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900">
              {rule.isActive ? "Pause" : "Activate"}
            </SubmitButton>
          </form>
          <form action={deleteRule}>
            <input type="hidden" name="ruleId" value={rule.id} />
            <SubmitButton className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950">
              Delete
            </SubmitButton>
          </form>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <code className="rounded bg-zinc-100 px-2 py-1 font-mono text-xs text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
          {rule.conditionField} {rule.conditionOp}
          {rule.conditionOp !== ConditionOp.EXISTS ? ` "${rule.conditionValue}"` : ""}
        </code>
        <span className="text-xs text-zinc-400 dark:text-zinc-500">
          {rule.targetSignal.toLowerCase()} · added {dateFmt.format(rule.createdAt)}
        </span>
      </div>
    </div>
  );
}
