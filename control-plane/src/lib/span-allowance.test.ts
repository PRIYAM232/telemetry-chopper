import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getSpanSavings, monthSpanSavings, type MonthSpanUsage } from "./span-allowance";
import { createFleet } from "@test/db";

const GB = 1e9;
const prices = { tracesPricePerGb: 0.1, tracesIndexPricePerMillion: 2.04 };
const none = { tracesIncludedGbPerMonth: 0, tracesIncludedIndexedMillionsPerMonth: 0 };
// 10 Datadog APM hosts: 150 GB and 1M indexed spans each.
const tenHosts = { tracesIncludedGbPerMonth: 1500, tracesIncludedIndexedMillionsPerMonth: 10 };

function month(over: Partial<MonthSpanUsage>): MonthSpanUsage {
  const m = { forwardedBytes: 0, droppedBytes: 0, received: 0, dropped: 0, unindexed: 0, ...over };
  return { windowDroppedBytes: m.droppedBytes, windowSavedEvents: m.dropped + m.unindexed, ...m, ...over };
}

describe("monthSpanSavings", () => {
  it("without an allowance, prices every dropped GB and span", () => {
    const s = monthSpanSavings(
      month({ forwardedBytes: 200 * GB, droppedBytes: 80 * GB, received: 5e6, dropped: 2e6, unindexed: 1e6 }),
      none,
      prices,
    );
    expect(s.ingest).toBeCloseTo(8); // 80 GB x $0.10
    expect(s.indexing).toBeCloseTo(6.12); // 3M x $2.04
  });

  it("saves nothing while the month stays inside the allowance", () => {
    const s = monthSpanSavings(
      month({ forwardedBytes: 900 * GB, droppedBytes: 400 * GB, received: 8e6, dropped: 3e6 }),
      tenHosts,
      prices,
    );
    expect(s.ingest).toBe(0);
    expect(s.indexing).toBe(0);
  });

  it("saves only the part above the allowance when drops cross it", () => {
    // 1,800 GB without Chopper, 1,200 GB with: only 300 GB was ever billable.
    // 13M spans indexed without Chopper, 9M with: only 3M was billable.
    const s = monthSpanSavings(
      month({ forwardedBytes: 1200 * GB, droppedBytes: 600 * GB, received: 13e6, dropped: 3e6, unindexed: 1e6 }),
      tenHosts,
      prices,
    );
    expect(s.ingest).toBeCloseTo(30); // 300 GB x $0.10
    expect(s.indexing).toBeCloseTo(6.12); // 3M x $2.04
  });

  it("counts only the indexed share of spans against the indexing allowance", () => {
    const usage = month({ forwardedBytes: 0, droppedBytes: 0, received: 13e6, dropped: 3e6, unindexed: 1e6 });
    // 10M included, 50% indexed: 6.5M would have been indexed, inside the allowance.
    expect(monthSpanSavings(usage, tenHosts, { ...prices, tracesIndexedSharePct: 50 }).indexing).toBe(0);
    // 1M included, 10% indexed: 1.3M without Chopper, 0.9M with -> 0.3M saved.
    const oneHost = { tracesIncludedGbPerMonth: 150, tracesIncludedIndexedMillionsPerMonth: 1 };
    expect(monthSpanSavings(usage, oneHost, { ...prices, tracesIndexedSharePct: 10 }).indexing).toBeCloseTo(0.612);
  });

  it("gives a window its share of the month's savings", () => {
    const s = monthSpanSavings(
      month({
        forwardedBytes: 2000 * GB, droppedBytes: 400 * GB, received: 20e6, dropped: 4e6,
        windowDroppedBytes: 100 * GB, windowSavedEvents: 1e6,
      }),
      tenHosts,
      prices,
    );
    expect(s.ingest).toBeCloseTo(10); // a quarter of 400 GB x $0.10
    expect(s.indexing).toBeCloseTo(2.04); // a quarter of 4M x $2.04
  });
});

describe("getSpanSavings", () => {
  async function heartbeat(fleetId: string, at: Date, fwdGb: number, dropGb: number, received: number, dropped: number) {
    await prisma.fleetMetric.create({
      data: {
        fleetId, createdAt: at,
        tracesReceived: received, tracesDropped: dropped,
        tracesForwardedBytes: BigInt(fwdGb * GB), tracesDroppedBytes: BigInt(dropGb * GB),
      },
    });
  }

  it("applies the allowance to each billing month separately", async () => {
    const fleet = await createFleet();
    const allowance = { tracesIncludedGbPerMonth: 150, tracesIncludedIndexedMillionsPerMonth: 1 };
    // September: 100 GB forwarded + 100 dropped, 200 GB without Chopper -> 50 GB saved.
    await heartbeat(fleet.id, new Date(Date.UTC(2026, 8, 10)), 100, 100, 2_000_000, 500_000);
    // October: 200 forwarded + 50 dropped, already over the allowance -> all 50 GB saved.
    await heartbeat(fleet.id, new Date(Date.UTC(2026, 9, 5)), 200, 25, 1_000_000, 0);
    await heartbeat(fleet.id, new Date(Date.UTC(2026, 9, 15)), 0, 25, 0, 0);
    const now = new Date(Date.UTC(2026, 9, 20));

    const all = await getSpanSavings(fleet.id, null, now, 1, allowance, prices);
    expect(all.ingest).toBeCloseTo(10); // (50 + 50) GB x $0.10
    // September: 2M indexed without, 1.5M with, 1M included -> 0.5M saved.
    expect(all.indexing).toBeCloseTo(1.02);

    // From October 10: October's 50 GB saving, half of it dropped inside the window.
    const recent = await getSpanSavings(fleet.id, new Date(Date.UTC(2026, 9, 10)), now, 1, allowance, prices);
    expect(recent.ingest).toBeCloseTo(2.5);
    expect(recent.indexing).toBe(0);
  });

  it("returns 0 for a fleet with no heartbeats", async () => {
    const fleet = await createFleet();
    expect(await getSpanSavings(fleet.id, null, new Date(), 1, tenHosts, prices)).toEqual({ ingest: 0, indexing: 0 });
  });
});
