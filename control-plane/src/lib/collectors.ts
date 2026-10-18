// Active collector tracking (issue #46). Collectors identify themselves in
// every heartbeat; the policy endpoint serves how many are active so a
// fleet-wide THROTTLE rule can split its rate between them, and the
// dashboard shows the same count.

import { prisma } from "@/lib/prisma";

// A collector counts as active until this many of its own stats intervals
// pass without a heartbeat, and never for less than MIN_ACTIVE_WINDOW_MS, so
// one late heartbeat doesn't flap the count (and every collector's share).
const MISSED_INTERVALS = 3;
const MIN_ACTIVE_WINDOW_MS = 30_000;

// Rows this stale belong to collectors long gone; heartbeats prune them.
export const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

export function isActive(
  c: { intervalSeconds: number; lastSeenAt: Date },
  now: number,
): boolean {
  const window = Math.max(MIN_ACTIVE_WINDOW_MS, MISSED_INTERVALS * c.intervalSeconds * 1000);
  return now - c.lastSeenAt.getTime() <= window;
}

export async function countActiveCollectors(fleetId: string): Promise<number> {
  const now = Date.now();
  // Anything older than the prune horizon can't be active; the window is
  // bounded by the interval cap the stats route enforces.
  const rows = await prisma.collectorInstance.findMany({
    where: { fleetId, lastSeenAt: { gte: new Date(now - PRUNE_AFTER_MS) } },
    select: { intervalSeconds: true, lastSeenAt: true },
  });
  return rows.filter((r) => isActive(r, now)).length;
}
