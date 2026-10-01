// Segmented control for the savings window (issue #15). Plain links to
// ?range=…, so the choice is shareable, survives AutoRefresh (router.refresh
// keeps the URL) and works without JavaScript.

import Link from "next/link";
import { TIME_RANGES, type TimeRange } from "@/lib/time-range";

const SHORT_LABEL: Record<TimeRange, string> = {
  "1h": "1h",
  "24h": "24h",
  "7d": "7d",
  all: "All time",
};

export function RangePicker({ range }: { range: TimeRange }) {
  return (
    <nav
      aria-label="Savings time range"
      className="inline-flex rounded-lg border border-zinc-200 bg-white p-0.5 text-sm dark:border-zinc-800 dark:bg-zinc-950"
    >
      {TIME_RANGES.map((r) => {
        const selected = r === range;
        return (
          <Link
            key={r}
            href={`/dashboard?range=${r}`}
            scroll={false}
            aria-current={selected ? "true" : undefined}
            className={`rounded-md px-3 py-1 font-medium tabular-nums ${
              selected
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
            }`}
          >
            {SHORT_LABEL[r]}
          </Link>
        );
      })}
    </nav>
  );
}
