"use client";

// Cumulative volume this billing period, with and without the ruleset,
// against the committed tier. A client island only for the hover layer
// (crosshair + tooltip); the data arrives fully computed from page.tsx and
// refreshes with the rest of the dashboard every 10s.
//
// Colors are the reference data-viz palette's first two categorical slots
// (blue = billable, orange = without Chopper), stepped separately for dark
// mode; the commitment is a neutral reference line, not a series.

import { useRef, useState } from "react";
import { formatBytes } from "@/lib/format";

// t is where the point sits on the time axis (end of its day, or now for
// today); day is the UTC day its cumulative totals run through, or null for
// the zero point at the period start.
export type ChartPoint = { t: number; day: number | null; billable: number; without: number };

const W = 640;
const H = 220;
const M = { top: 14, right: 16, bottom: 26, left: 64 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;

const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

// 1 / 2 / 2.5 / 5 x 10^n steps, so tick labels land on round numbers.
function niceStep(max: number, ticks: number): number {
  const raw = max / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const f of [1, 2, 2.5, 5, 10]) {
    if (f * pow >= raw) return f * pow;
  }
  return 10 * pow;
}

export function OverageChart({
  points,
  committedBytes,
  periodStart,
  periodEnd,
}: {
  points: ChartPoint[];
  committedBytes: number;
  periodStart: number;
  periodEnd: number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const peak = Math.max(committedBytes * 1.1, ...points.map((p) => p.without), 1);
  const step = niceStep(peak, 4);
  const yMax = Math.ceil(peak / step) * step;
  const yTicks: number[] = [];
  for (let v = 0; v <= yMax + step / 2; v += step) yTicks.push(v);

  const x = (t: number) => M.left + ((t - periodStart) / (periodEnd - periodStart)) * PW;
  const y = (b: number) => M.top + PH - (b / yMax) * PH;
  const path = (key: "billable" | "without") =>
    points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`).join("");

  const mid = periodStart + (periodEnd - periodStart) / 2;
  const last = points[points.length - 1];
  const active = hover !== null ? points[hover] : null;

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    const svg = svgRef.current;
    if (!svg || points.length === 0) return;
    const r = svg.getBoundingClientRect();
    const t = periodStart + (((e.clientX - r.left) / r.width) * W - M.left) / PW * (periodEnd - periodStart);
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(points[i].t - t) < Math.abs(points[best].t - t)) best = i;
    }
    setHover(best);
  }

  return (
    <figure className="relative">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
        <LegendKey className="h-0.5 bg-[#2a78d6] dark:bg-[#3987e5]" label="Billable (with Chopper)" />
        <LegendKey className="h-0.5 bg-[#eb6834] dark:bg-[#d95926]" label="Without Chopper" />
        <LegendKey className="h-px bg-zinc-500" label="Commitment" />
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full overflow-visible"
        role="img"
        aria-label={`Cumulative volume this period: ${formatBytes(last?.billable ?? 0)} billable, ${formatBytes(last?.without ?? 0)} without Chopper, against a ${formatBytes(committedBytes)} commitment.`}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} className="stroke-zinc-100 dark:stroke-zinc-900" strokeWidth={1} />
            <text x={M.left - 8} y={y(v)} dy="0.32em" textAnchor="end" className="fill-zinc-400 text-[10px] tabular-nums dark:fill-zinc-500">
              {formatBytes(v)}
            </text>
          </g>
        ))}
        {[periodStart, mid, periodEnd].map((t, i) => (
          <text
            key={t}
            x={x(t)}
            y={H - 6}
            textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
            className="fill-zinc-400 text-[10px] dark:fill-zinc-500"
          >
            {dayFmt.format(new Date(t))}
          </text>
        ))}

        <line x1={M.left} x2={W - M.right} y1={y(committedBytes)} y2={y(committedBytes)} className="stroke-zinc-500" strokeWidth={1} />
        {/* Labeled at the left: cumulative lines start at zero, so the space
            above the commitment is clear there, while the line ends (and
            their end dots) crowd the right edge. */}
        <text x={M.left + 4} y={y(committedBytes) - 5} className="fill-zinc-500 text-[10px] dark:fill-zinc-400">
          Commitment · {formatBytes(committedBytes)}
        </text>

        {points.length > 1 && (
          <>
            <path d={path("without")} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className="stroke-[#eb6834] dark:stroke-[#d95926]" />
            <path d={path("billable")} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className="stroke-[#2a78d6] dark:stroke-[#3987e5]" />
          </>
        )}
        {last && (
          <>
            <circle cx={x(last.t)} cy={y(last.without)} r={4} strokeWidth={2} className="fill-[#eb6834] stroke-white dark:fill-[#d95926] dark:stroke-zinc-950" />
            <circle cx={x(last.t)} cy={y(last.billable)} r={4} strokeWidth={2} className="fill-[#2a78d6] stroke-white dark:fill-[#3987e5] dark:stroke-zinc-950" />
          </>
        )}

        {active && (
          <g pointerEvents="none">
            <line x1={x(active.t)} x2={x(active.t)} y1={M.top} y2={M.top + PH} className="stroke-zinc-300 dark:stroke-zinc-700" strokeWidth={1} />
            <circle cx={x(active.t)} cy={y(active.without)} r={4} strokeWidth={2} className="fill-[#eb6834] stroke-white dark:fill-[#d95926] dark:stroke-zinc-950" />
            <circle cx={x(active.t)} cy={y(active.billable)} r={4} strokeWidth={2} className="fill-[#2a78d6] stroke-white dark:fill-[#3987e5] dark:stroke-zinc-950" />
          </g>
        )}

        <rect
          x={M.left}
          y={M.top}
          width={PW}
          height={PH}
          fill="transparent"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>

      {active && (
        <div
          className="pointer-events-none absolute top-8 z-10 w-56 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
          // Sit beside the crosshair on whichever side has room, so the
          // tooltip never covers the hovered point or leaves the card.
          style={
            x(active.t) > W / 2
              ? { right: `calc(${100 - (x(active.t) / W) * 100}% + 12px)` }
              : { left: `calc(${(x(active.t) / W) * 100}% + 12px)` }
          }
        >
          <p className="font-medium text-zinc-900 dark:text-zinc-100">
            {active.day === null ? "Period start" : `Through ${dayFmt.format(new Date(active.day))}`}
          </p>
          <TooltipRow className="bg-[#2a78d6] dark:bg-[#3987e5]" label="Billable" value={formatBytes(active.billable)} />
          <TooltipRow className="bg-[#eb6834] dark:bg-[#d95926]" label="Without Chopper" value={formatBytes(active.without)} />
          <p className="mt-1 text-zinc-500 dark:text-zinc-400">
            {((active.billable / committedBytes) * 100).toFixed(1)}% of commitment
          </p>
        </div>
      )}

      <details className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
        <summary className="cursor-pointer select-none">Table view</summary>
        <table className="mt-2 w-full text-left tabular-nums">
          <thead>
            <tr className="text-zinc-400 dark:text-zinc-500">
              <th className="py-1 font-medium">Through</th>
              <th className="py-1 font-medium">Billable</th>
              <th className="py-1 font-medium">Without Chopper</th>
            </tr>
          </thead>
          <tbody>
            {points.slice(1).map((p) => (
              <tr key={p.t} className="border-t border-zinc-100 dark:border-zinc-900">
                <td className="py-1">{p.day === null ? "" : dayFmt.format(new Date(p.day))}</td>
                <td className="py-1 text-zinc-700 dark:text-zinc-300">{formatBytes(p.billable)}</td>
                <td className="py-1 text-zinc-700 dark:text-zinc-300">{formatBytes(p.without)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

function LegendKey({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block w-4 rounded-full ${className}`} />
      {label}
    </span>
  );
}

function TooltipRow({ className, label, value }: { className: string; label: string; value: string }) {
  return (
    <p className="mt-1 flex items-center justify-between gap-4 text-zinc-600 dark:text-zinc-300">
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        <span className={`inline-block h-2 w-2 rounded-full ${className}`} />
        {label}
      </span>
      <span className="whitespace-nowrap tabular-nums text-zinc-900 dark:text-zinc-100">{value}</span>
    </p>
  );
}
