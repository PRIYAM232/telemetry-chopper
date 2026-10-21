import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { computeSavings, getDroppedSeriesHours, HOURS_PER_BILLING_MONTH } from "./pricing";
import { createFleet } from "@test/db";

const datadog = {
  tracesPricePerGb: 0.1,
  logsPricePerGb: 0.1,
  metricsPricePerGb: 0,
  tracesIndexPricePerMillion: 2.04,
  logsIndexPricePerMillion: 2.04,
  metricsPricePer100Series: 5,
};
const nothingDropped = {
  droppedBytes: { traces: 0, logs: 0, metrics: 0 },
  droppedEvents: { traces: 0, logs: 0 },
  unindexedEvents: { traces: 0, logs: 0 },
};

describe("computeSavings", () => {
  it("prices logs and spans at Datadog's ingest and indexing rates", () => {
    const s = computeSavings(
      {
        droppedBytes: { traces: 30e9, logs: 50e9, metrics: 0 },
        droppedEvents: { traces: 10e6, logs: 20e6 },
        unindexedEvents: { traces: 0, logs: 5e6 },
      },
      datadog,
    );
    expect(s.ingest.logs).toBeCloseTo(5);
    expect(s.ingest.traces).toBeCloseTo(3);
    expect(s.indexing.logs).toBeCloseTo(51);
    expect(s.indexing.traces).toBeCloseTo(20.4);
    expect(s.totalUSD).toBeCloseTo(79.4);
  });

  it("prices a series dropped for a whole month at its share of the per-100 price", () => {
    // 1,000 series dropped for every hour of a billing month: Datadog would
    // have billed 1,000 custom metrics, 10 x $5.
    const s = computeSavings({ ...nothingDropped, droppedSeriesHours: 1000 * HOURS_PER_BILLING_MONTH }, datadog);
    expect(s.series.total).toBeCloseTo(50);
    expect(s.totalUSD).toBeCloseTo(50);
  });

  it("prices a series dropped for part of a month pro rata", () => {
    // 200 series for one day.
    const s = computeSavings({ ...nothingDropped, droppedSeriesHours: 200 * 24 }, datadog);
    expect(s.series.total).toBeCloseTo((200 * 24) / HOURS_PER_BILLING_MONTH / 100 * 5);
  });

  it("prices indexing only at the share of events the vendor indexes", () => {
    // Datadog retention filters keep 5% of spans; logs are all indexed.
    const s = computeSavings(
      {
        ...nothingDropped,
        droppedEvents: { traces: 10e6, logs: 1e6 },
        unindexedEvents: { traces: 0, logs: 1e6 },
      },
      { ...datadog, tracesIndexedSharePct: 5, logsIndexedSharePct: 100 },
    );
    expect(s.indexing.traces).toBeCloseTo(1.02); // 10M x 5% x $2.04
    expect(s.indexing.logs).toBeCloseTo(4.08); // 2M x $2.04
  });

  it("treats a missing indexed share as 100%", () => {
    const s = computeSavings({ ...nothingDropped, droppedEvents: { traces: 1e6, logs: 0 } }, datadog);
    expect(s.indexing.traces).toBeCloseTo(2.04);
  });

  it("saves nothing on series when the rate card has no series price", () => {
    const s = computeSavings(
      { ...nothingDropped, droppedSeriesHours: 5000 },
      { ...datadog, metricsPricePer100Series: 0 },
    );
    expect(s.series.total).toBe(0);
  });
});

describe("getDroppedSeriesHours", () => {
  it("sums every collector's hours that start inside the window", async () => {
    const fleet = await createFleet();
    const other = await createFleet("other");
    const at = (h: number) => new Date(Date.UTC(2026, 9, 20, h));
    await prisma.metricSeriesHour.createMany({
      data: [
        { fleetId: fleet.id, collectorId: "c1", hour: at(8), droppedSeries: 100 },
        { fleetId: fleet.id, collectorId: "c1", hour: at(9), droppedSeries: 120 },
        { fleetId: fleet.id, collectorId: "c2", hour: at(9), droppedSeries: 30 },
        { fleetId: other.id, collectorId: "c1", hour: at(9), droppedSeries: 999 },
      ],
    });
    expect(await getDroppedSeriesHours(fleet.id, null)).toBe(250);
    expect(await getDroppedSeriesHours(fleet.id, at(9))).toBe(150);
    expect(await getDroppedSeriesHours(fleet.id, at(10))).toBe(0);
  });
});
