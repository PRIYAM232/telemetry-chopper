import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { POST } from "./route";
import { createFleet, createRule } from "@test/db";
import { fleetParams, fleetRequest } from "@test/request";

async function report(fleet: { id: string; apiKey: string }, body: unknown) {
  return POST(
    fleetRequest(`/api/v1/telemetry/${fleet.id}/stats`, { method: "POST", apiKey: fleet.apiKey, body }),
    fleetParams(fleet.id),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/v1/telemetry/:fleetId/stats", () => {
  it("stores one FleetMetric row with every counter", async () => {
    const fleet = await createFleet();
    const response = await report(fleet, {
      traces_received: 100, traces_dropped: 40,
      logs_received: 50, logs_dropped: 10,
      metrics_received: 30, metrics_dropped: 3,
      traces_unindexed: 7, logs_unindexed: 2,
      traces_dropped_bytes: 4000, logs_dropped_bytes: 1000, metrics_dropped_bytes: 300,
      traces_forwarded_bytes: 6000, logs_forwarded_bytes: 4000, metrics_forwarded_bytes: 2700,
    });

    expect(response.status).toBe(204);
    const rows = await prisma.fleetMetric.findMany({ where: { fleetId: fleet.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tracesReceived: 100, tracesDropped: 40,
      logsReceived: 50, logsDropped: 10,
      metricsReceived: 30, metricsDropped: 3,
      tracesUnindexed: 7, logsUnindexed: 2,
      tracesDroppedBytes: BigInt(4000), logsDroppedBytes: BigInt(1000), metricsDroppedBytes: BigInt(300),
      tracesForwardedBytes: BigInt(6000), logsForwardedBytes: BigInt(4000), metricsForwardedBytes: BigInt(2700),
    });
  });

  it("stores an empty body as an all-zero heartbeat", async () => {
    const fleet = await createFleet();
    expect((await report(fleet, {})).status).toBe(204);
    const row = await prisma.fleetMetric.findFirstOrThrow({ where: { fleetId: fleet.id } });
    expect(row).toMatchObject({ tracesReceived: 0, logsDropped: 0, metricsForwardedBytes: BigInt(0) });
  });

  it("records the pre-signal { received, dropped } shape as trace counts", async () => {
    const fleet = await createFleet();
    await report(fleet, { received: 12, dropped: 5 });
    const row = await prisma.fleetMetric.findFirstOrThrow({ where: { fleetId: fleet.id } });
    expect(row).toMatchObject({ tracesReceived: 12, tracesDropped: 5, logsReceived: 0 });
  });

  it("clamps counts to INT4 instead of rejecting them", async () => {
    const fleet = await createFleet();
    expect((await report(fleet, { traces_received: 5_000_000_000 })).status).toBe(204);
    const row = await prisma.fleetMetric.findFirstOrThrow({ where: { fleetId: fleet.id } });
    expect(row.tracesReceived).toBe(2_147_483_647);
  });

  it.each([
    ["a negative count", { traces_received: -1 }],
    ["a fractional count", { logs_dropped: 1.5 }],
    ["a string count", { metrics_received: "10" }],
    ["negative bytes", { traces_dropped_bytes: -5 }],
    ["rules that aren't an array", { rules: { rule_id: "x" } }],
    ["a rule entry without rule_id", { rules: [{ matched: 1 }] }],
    ["a rule entry with a bad count", { rules: [{ rule_id: randomUUID(), matched: -1 }] }],
  ])("rejects %s with 400 and writes nothing", async (_, body) => {
    const fleet = await createFleet();
    expect((await report(fleet, body)).status).toBe(400);
    expect(await prisma.fleetMetric.count()).toBe(0);
  });

  it("rejects a body that isn't JSON", async () => {
    const fleet = await createFleet();
    const response = await report(fleet, "{not json");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "request body must be JSON" });
  });

  it("writes a RuleMetric row per owned rule and skips unknown, malformed and foreign rule IDs", async () => {
    const fleet = await createFleet();
    const other = await createFleet("other");
    const mine = await createRule(fleet.id);
    const theirs = await createRule(other.id);

    const response = await report(fleet, {
      traces_received: 10,
      rules: [
        { rule_id: mine.id, matched: 8, dropped: 6, dropped_bytes: 600, unindexed: 0, evaluated: 10 },
        { rule_id: randomUUID(), matched: 1, dropped: 1, dropped_bytes: 1, unindexed: 0 },
        { rule_id: "not-a-uuid", matched: 1, dropped: 1, dropped_bytes: 1, unindexed: 0 },
        { rule_id: theirs.id, matched: 1, dropped: 1, dropped_bytes: 1, unindexed: 0 },
      ],
    });

    expect(response.status).toBe(204);
    const rows = await prisma.ruleMetric.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fleetId: fleet.id, ruleId: mine.id,
      matched: 8, dropped: 6, droppedBytes: BigInt(600), unindexed: 0, evaluated: 10,
    });
    expect(await prisma.fleetMetric.count({ where: { fleetId: fleet.id } })).toBe(1);
  });

  it("registers the sending collector and refreshes it on the next heartbeat", async () => {
    const fleet = await createFleet();
    await report(fleet, { collector_id: "gw-1", interval_seconds: 15 });
    const first = await prisma.collectorInstance.findFirstOrThrow({ where: { fleetId: fleet.id } });
    expect(first).toMatchObject({ instanceId: "gw-1", intervalSeconds: 15 });

    await report(fleet, { collector_id: "gw-1", interval_seconds: 30 });
    const rows = await prisma.collectorInstance.findMany({ where: { fleetId: fleet.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].intervalSeconds).toBe(30);
    expect(rows[0].lastSeenAt.getTime()).toBeGreaterThanOrEqual(first.lastSeenAt.getTime());
  });

  it.each([
    ["missing", undefined, 10],
    ["zero", 0, 10],
    ["over an hour", 7200, 10],
    ["a string", "15", 10],
    ["fractional", 2.5, 2.5],
  ])("stores a %s interval as %s → %s seconds", async (_, interval, expected) => {
    const fleet = await createFleet();
    await report(fleet, { collector_id: "gw-1", interval_seconds: interval });
    const row = await prisma.collectorInstance.findFirstOrThrow({ where: { fleetId: fleet.id } });
    expect(row.intervalSeconds).toBe(expected);
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["too long", "x".repeat(129)],
    ["not a string", 42],
  ])("still stores the heartbeat when collector_id is %s, without registering a collector", async (_, id) => {
    const fleet = await createFleet();
    expect((await report(fleet, { collector_id: id, traces_received: 1 })).status).toBe(204);
    expect(await prisma.fleetMetric.count()).toBe(1);
    expect(await prisma.collectorInstance.count()).toBe(0);
  });

  it("prunes the fleet's collectors silent for a day, and no one else's", async () => {
    const fleet = await createFleet();
    const other = await createFleet("other");
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await prisma.collectorInstance.createMany({
      data: [
        { fleetId: fleet.id, instanceId: "gone", intervalSeconds: 10, lastSeenAt: old },
        { fleetId: fleet.id, instanceId: "recent", intervalSeconds: 10, lastSeenAt: new Date(Date.now() - 60_000) },
        { fleetId: other.id, instanceId: "gone-elsewhere", intervalSeconds: 10, lastSeenAt: old },
      ],
    });

    await report(fleet, { collector_id: "gw-1" });

    const ids = (await prisma.collectorInstance.findMany({ orderBy: { instanceId: "asc" } })).map((c) => c.instanceId);
    expect(ids).toEqual(["gone-elsewhere", "gw-1", "recent"]);
  });

  it("writes the heartbeat, its rule rows and its collector in one transaction", async () => {
    const fleet = await createFleet();
    // Make the ownership check vouch for a rule that doesn't exist, so the
    // RuleMetric insert fails on its foreign key mid-transaction.
    const ghost = randomUUID();
    vi.spyOn(prisma.policyRule, "findMany").mockResolvedValue([{ id: ghost }] as never);

    await expect(
      report(fleet, {
        traces_received: 5,
        collector_id: "gw-1",
        rules: [{ rule_id: ghost, matched: 1, dropped: 1, dropped_bytes: 1, unindexed: 0 }],
      }),
    ).rejects.toThrow();

    expect(await prisma.fleetMetric.count()).toBe(0);
    expect(await prisma.collectorInstance.count()).toBe(0);
  });

  it("rejects a wrong key with 401 and writes nothing", async () => {
    const fleet = await createFleet();
    const response = await report({ id: fleet.id, apiKey: "wrong" }, { traces_received: 1 });
    expect(response.status).toBe(401);
    expect(await prisma.fleetMetric.count()).toBe(0);
  });
});
