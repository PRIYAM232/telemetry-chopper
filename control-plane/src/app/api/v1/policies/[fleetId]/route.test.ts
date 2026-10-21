import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { GET } from "./route";
import { createFleet, createRule } from "@test/db";
import { fleetParams, fleetRequest } from "@test/request";

async function poll(fleet: { id: string; apiKey: string }, headers: Record<string, string> = {}) {
  return GET(fleetRequest(`/api/v1/policies/${fleet.id}`, { apiKey: fleet.apiKey, headers }), fleetParams(fleet.id));
}

describe("GET /api/v1/policies/:fleetId", () => {
  it("serves the fleet's live rules, oldest first, with a SHA-256 ETag of the body", async () => {
    const fleet = await createFleet();
    const first = await createRule(fleet.id, { name: "first", createdAt: new Date(Date.now() - 60_000) });
    const second = await createRule(fleet.id, { name: "second" });

    const response = await poll(fleet);
    const body = await response.text();
    const json = JSON.parse(body);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("etag")).toBe(`"${createHash("sha256").update(body).digest("hex")}"`);
    expect(json.fleet_id).toBe(fleet.id);
    expect(json.rules.map((r: { id: string }) => r.id)).toEqual([first.id, second.id]);
    expect(json.active_collectors).toBe(0);
  });

  it("answers a matching If-None-Match with an empty 304 carrying the same ETag", async () => {
    const fleet = await createFleet();
    await createRule(fleet.id);
    const etag = (await poll(fleet)).headers.get("etag")!;

    const response = await poll(fleet, { "if-none-match": etag });

    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(etag);
    expect(await response.text()).toBe("");
  });

  it("changes the ETag when the ruleset changes", async () => {
    const fleet = await createFleet();
    await createRule(fleet.id);
    const etag = (await poll(fleet)).headers.get("etag")!;

    await createRule(fleet.id, { name: "another" });
    const response = await poll(fleet, { "if-none-match": etag });

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).not.toBe(etag);
  });

  it("omits soft-deleted rules, and the deletedAt field from the ones it serves", async () => {
    const fleet = await createFleet();
    const kept = await createRule(fleet.id, { name: "kept" });
    const deleted = await createRule(fleet.id, { name: "deleted" });

    await prisma.policyRule.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
    const json = await (await poll(fleet)).json();
    expect(json.rules.map((r: { id: string }) => r.id)).toEqual([kept.id]);
    expect(json.rules[0]).not.toHaveProperty("deletedAt");
  });

  it("serves paused rules, which collectors skip themselves", async () => {
    const fleet = await createFleet();
    await createRule(fleet.id, { isActive: false });
    const json = await (await poll(fleet)).json();
    expect(json.rules).toHaveLength(1);
    expect(json.rules[0].isActive).toBe(false);
  });

  it("never serves another fleet's rules", async () => {
    const [mine, theirs] = [await createFleet("mine"), await createFleet("theirs")];
    await createRule(theirs.id);
    expect((await (await poll(mine)).json()).rules).toEqual([]);
  });

  it("counts only collectors that heartbeated within their active window", async () => {
    const fleet = await createFleet();
    const other = await createFleet("other");
    const now = Date.now();
    await prisma.collectorInstance.createMany({
      data: [
        { fleetId: fleet.id, instanceId: "fresh", intervalSeconds: 10, lastSeenAt: new Date(now - 5_000) },
        // 3 × 60s interval = 3 min window; 2 min ago is still active.
        { fleetId: fleet.id, instanceId: "slow", intervalSeconds: 60, lastSeenAt: new Date(now - 120_000) },
        // 3 × 10s is under the 30s floor; 45s ago is gone.
        { fleetId: fleet.id, instanceId: "stale", intervalSeconds: 10, lastSeenAt: new Date(now - 45_000) },
        { fleetId: other.id, instanceId: "elsewhere", intervalSeconds: 10, lastSeenAt: new Date(now) },
      ],
    });

    expect((await (await poll(fleet)).json()).active_collectors).toBe(2);
  });

  it("changes the ETag when a collector joins", async () => {
    const fleet = await createFleet();
    const etag = (await poll(fleet)).headers.get("etag")!;
    await prisma.collectorInstance.create({
      data: { fleetId: fleet.id, instanceId: "new", intervalSeconds: 10, lastSeenAt: new Date() },
    });
    expect((await poll(fleet, { "if-none-match": etag })).status).toBe(200);
  });

  it("rejects a wrong key with 401 and no rules", async () => {
    const fleet = await createFleet();
    await createRule(fleet.id);
    const response = await poll({ id: fleet.id, apiKey: "wrong" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid fleet credentials" });
  });
});
