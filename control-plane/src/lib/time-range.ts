// The dashboard's savings window (issue #15). All-time sums let traffic from
// before a rule change dominate the denominator for hours afterwards, so the
// banner and breakdown default to a trailing window computed from FleetMetric
// heartbeat timestamps. The billing-period section keeps its own window.

export const TIME_RANGES = ["1h", "24h", "7d", "all"] as const;
export type TimeRange = (typeof TIME_RANGES)[number];

export const DEFAULT_TIME_RANGE: TimeRange = "24h";

const RANGE_MS: Record<Exclude<TimeRange, "all">, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

const RANGE_LABEL: Record<TimeRange, string> = {
  "1h": "last hour",
  "24h": "last 24 hours",
  "7d": "last 7 days",
  all: "all time",
};

// Unknown or repeated ?range= values fall back to the default rather than 404.
export function parseTimeRange(value: string | string[] | undefined): TimeRange {
  return typeof value === "string" && (TIME_RANGES as readonly string[]).includes(value)
    ? (value as TimeRange)
    : DEFAULT_TIME_RANGE;
}

// The window's inclusive lower bound, or null for all time.
export function rangeStart(range: TimeRange, nowMs: number): Date | null {
  return range === "all" ? null : new Date(nowMs - RANGE_MS[range]);
}

export function rangeLabel(range: TimeRange): string {
  return RANGE_LABEL[range];
}
