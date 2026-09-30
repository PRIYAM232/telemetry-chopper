// The dashboard's savings breakdown: all-time savings split by what each
// dollar pays for — ingest (bytes the vendor never received) vs indexing
// (events the vendor never indexed) — as a proportional bar with direct
// labels and a per-signal table. Server-rendered; refreshes with the page.
//
// Segment colors are the reference data-viz palette's categorical slots in
// fixed order (blue, orange), each with its own dark-mode step. Text never
// wears the series color; the swatch beside it carries identity.

import Link from "next/link";
import { formatBytes, formatUSD } from "@/lib/format";
import type { RateCard, Savings } from "@/lib/pricing";

const integerFmt = new Intl.NumberFormat("en-US");

type Segment = {
  key: string;
  label: string;
  usd: number;
  detail: string;
  swatch: string;
};

// Whole percents, but never round a real sliver up to "1%" or down to "0%".
function formatShare(fraction: number): string {
  const pct = fraction * 100;
  if (pct > 0 && pct < 1) return "<1%";
  if (pct < 100 && pct > 99) return ">99%";
  return `${pct.toFixed(0)}%`;
}

export function SavingsBreakdown({ savings, rateCard }: { savings: Savings; rateCard: RateCard }) {
  const indexingPriced =
    rateCard.tracesIndexPricePerMillion > 0 || rateCard.logsIndexPricePerMillion > 0;

  const segments: Segment[] = [
    {
      key: "ingest",
      label: "Ingest savings",
      usd: savings.ingest.total,
      detail: `${formatBytes(savings.droppedBytes)} never sent to the vendor`,
      swatch: "bg-[#2a78d6] dark:bg-[#3987e5]",
    },
    {
      key: "indexing",
      label: "Indexing savings",
      usd: savings.indexing.total,
      detail: indexingPriced
        ? `${integerFmt.format(savings.indexing.droppedEvents)} dropped + ${integerFmt.format(savings.indexing.unindexedEvents)} excluded events never indexed`
        : "Not priced: your rate card has no indexing price",
      swatch: "bg-[#eb6834] dark:bg-[#d95926]",
    },
  ];
  const total = segments.reduce((sum, s) => sum + s.usd, 0);

  const rows = [
    { label: "Spans", ingest: savings.ingest.traces, indexing: savings.indexing.traces as number | null },
    { label: "Logs", ingest: savings.ingest.logs, indexing: savings.indexing.logs as number | null },
    { label: "Metrics", ingest: savings.ingest.metrics, indexing: null },
  ];

  return (
    <section aria-label="Savings breakdown" className="mt-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Savings breakdown
          <span className="ml-2 font-normal text-zinc-500 dark:text-zinc-400">all time</span>
        </h2>
        <p className="text-sm tabular-nums text-zinc-500 dark:text-zinc-400">
          Total <span className="font-semibold text-zinc-900 dark:text-zinc-50">{formatUSD(total)}</span>
        </p>
      </div>

      {/* Proportional bar: one segment per savings source, 2px surface gap
          between them, rounded at the ends only. */}
      <div
        className="mt-3 flex h-3 gap-0.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-900"
        role="img"
        aria-label={segments.map((s) => `${s.label} ${formatUSD(s.usd)}`).join(", ")}
      >
        {total > 0 &&
          segments
            .filter((s) => s.usd > 0)
            .map((s) => (
              <div
                key={s.key}
                className={`h-full ${s.swatch}`}
                // Grow by percentage share, not raw dollars: flex-grow values
                // summing below 1 hand out only that fraction of the bar, so
                // a dev fleet's sub-cent savings would render as slivers.
                style={{ flexGrow: (s.usd / total) * 100, flexBasis: 0, minWidth: 2 }}
                title={`${s.label}: ${formatUSD(s.usd)} (${((s.usd / total) * 100).toFixed(1)}%)`}
              />
            ))}
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {segments.map((s) => (
          <div key={s.key}>
            <dt className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
              <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-sm ${s.swatch}`} />
              {s.label}
            </dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-zinc-900 dark:text-zinc-50">
              {formatUSD(s.usd)}
              {total > 0 && (
                <span className="ml-2 text-sm font-normal text-zinc-500 dark:text-zinc-400">
                  {formatShare(s.usd / total)}
                </span>
              )}
            </dd>
            <dd className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
              {s.detail}
              {s.key === "indexing" && !indexingPriced && (
                <>
                  {" · "}
                  <Link
                    href="/settings/pricing"
                    className="underline decoration-zinc-300 underline-offset-2 hover:text-zinc-700 dark:decoration-zinc-700 dark:hover:text-zinc-300"
                  >
                    add indexing prices
                  </Link>
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>

      <table className="mt-4 w-full text-left text-xs tabular-nums">
        <thead>
          <tr className="text-zinc-400 dark:text-zinc-500">
            <th className="py-1 font-medium">Signal</th>
            <th className="py-1 text-right font-medium">Ingest</th>
            <th className="py-1 text-right font-medium">Indexing</th>
            <th className="py-1 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody className="text-zinc-700 dark:text-zinc-300">
          {rows.map((r) => (
            <tr key={r.label} className="border-t border-zinc-100 dark:border-zinc-900">
              <td className="py-1.5">{r.label}</td>
              <td className="py-1.5 text-right">{formatUSD(r.ingest)}</td>
              <td className="py-1.5 text-right" title={r.indexing === null ? "Metrics aren't indexed events" : undefined}>
                {r.indexing === null ? "—" : formatUSD(r.indexing)}
              </td>
              <td className="py-1.5 text-right">{formatUSD(r.ingest + (r.indexing ?? 0))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
