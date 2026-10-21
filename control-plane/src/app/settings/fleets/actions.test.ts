import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashFleetKey } from "@/lib/fleet-keys";
import { FLEET_COOKIE, getFleetChoices } from "@/lib/fleet-selection";
import { rotateFleetKey } from "@/lib/fleets";
import { prisma } from "@/lib/prisma";
import { createFleet } from "@test/db";
import {
  createFleetAction,
  revokePreviousKeyAction,
  rotateFleetKeyAction,
  selectFleetAction,
  type FleetKeyState,
} from "./actions";

const env = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  operator: null as { id: string; email: string; name: null; mustChangePassword: boolean } | null,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (env.cookies.has(name) ? { name, value: env.cookies.get(name)! } : undefined),
    set: (name: string, value: string) => {
      env.cookies.set(name, value);
    },
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  requireOperator: async () => {
    if (!env.operator) throw new Error("NEXT_REDIRECT /login");
    return env.operator;
  },
}));

const initial: FleetKeyState = { error: null, issued: null };

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

beforeEach(async () => {
  env.cookies.clear();
  const op = await prisma.operator.create({
    data: { email: "ops@example.com", passwordHash: "scrypt$unused" },
  });
  env.operator = { id: op.id, email: op.email, name: null, mustChangePassword: false };
});

describe("createFleetAction", () => {
  it("creates the fleet, returns its key once, and audits only the key's hint", async () => {
    const state = await createFleetAction(initial, form({ name: "  prod-eu  ", description: "EU gateways" }));

    expect(state.error).toBeNull();
    const issued = state.issued!;
    expect(issued.fleetName).toBe("prod-eu");
    const fleet = await prisma.collectorFleet.findUniqueOrThrow({ where: { id: issued.fleetId } });
    expect(fleet.apiKeyHash).toBe(hashFleetKey(issued.key));
    expect(fleet.description).toBe("EU gateways");

    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: "FLEET_CREATED" } });
    expect(event).toMatchObject({ actor: "ops@example.com", fleetId: fleet.id, targetName: "prod-eu" });
    expect(JSON.stringify(event)).not.toContain(issued.key);
    expect(event.details).toEqual({ keyHint: issued.key.slice(-4) });
  });

  it.each([
    ["an empty name", { name: "   " }, "Enter a name for the fleet."],
    ["a long name", { name: "x".repeat(101) }, "Name must be at most 100 characters."],
    ["a long description", { name: "ok", description: "x".repeat(501) }, "Description must be at most 500 characters."],
  ])("rejects %s", async (_, fields, error) => {
    expect(await createFleetAction(initial, form(fields))).toEqual({ error, issued: null });
    expect(await prisma.collectorFleet.count()).toBe(0);
  });

  it("rejects a name another fleet already has, ignoring case", async () => {
    await createFleet("Prod-EU");
    const state = await createFleetAction(initial, form({ name: "prod-eu" }));
    expect(state).toEqual({ error: "A fleet named prod-eu already exists.", issued: null });
  });

  it("requires a signed-in operator", async () => {
    env.operator = null;
    await expect(createFleetAction(initial, form({ name: "x" }))).rejects.toThrow("NEXT_REDIRECT");
    expect(await prisma.collectorFleet.count()).toBe(0);
  });
});

describe("rotateFleetKeyAction", () => {
  it("issues a new key, keeps the old one for the chosen grace period, and audits it", async () => {
    const fleet = await createFleet("f");
    const before = Date.now();

    const state = await rotateFleetKeyAction(initial, form({ fleetId: fleet.id, graceSeconds: "3600" }));

    const issued = state.issued!;
    expect(issued.key).not.toBe(fleet.apiKey);
    const expires = new Date(issued.previousKeyExpiresAt!).getTime();
    expect(expires).toBeGreaterThanOrEqual(before + 3600_000);
    expect(expires).toBeLessThan(Date.now() + 3600_000 + 1000);

    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: "FLEET_KEY_ROTATED" } });
    expect(event.details).toMatchObject({ keyHint: issued.key.slice(-4), graceSeconds: 3600 });
    expect(JSON.stringify(event)).not.toContain(issued.key);
  });

  it.each([
    ["a grace period that isn't offered", { graceSeconds: "123" }, "Choose when the current key stops working."],
    ["a missing grace period", {}, "Choose when the current key stops working."],
  ])("rejects %s", async (_, fields, error) => {
    const fleet = await createFleet("f");
    const state = await rotateFleetKeyAction(initial, form({ fleetId: fleet.id, ...fields }));
    expect(state).toEqual({ error, issued: null });
    const row = await prisma.collectorFleet.findUniqueOrThrow({ where: { id: fleet.id } });
    expect(row.apiKeyHash).toBe(hashFleetKey(fleet.apiKey));
  });

  it("reports an unknown fleet", async () => {
    const state = await rotateFleetKeyAction(initial, form({ fleetId: randomUUID(), graceSeconds: "0" }));
    expect(state).toEqual({ error: "Fleet not found.", issued: null });
  });
});

describe("revokePreviousKeyAction", () => {
  it("ends the grace period and audits it", async () => {
    const fleet = await createFleet("f");
    await rotateFleetKey(fleet.id, 3600);

    expect(await revokePreviousKeyAction(fleet.id)).toEqual({ ok: true });
    const row = await prisma.collectorFleet.findUniqueOrThrow({ where: { id: fleet.id } });
    expect(row.previousApiKeyHash).toBeNull();
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: "FLEET_PREVIOUS_KEY_REVOKED" } });
    expect(event.details).toEqual({ keyHint: fleet.apiKey.slice(-4) });
  });

  it("says so when there is no previous key to revoke", async () => {
    const fleet = await createFleet("f");
    expect(await revokePreviousKeyAction(fleet.id)).toEqual({
      ok: false,
      error: "The previous key has already stopped working.",
    });
    expect(await prisma.auditEvent.count()).toBe(0);
  });
});

describe("fleet selection", () => {
  it("shows the oldest fleet until another is picked, then remembers the pick", async () => {
    const first = await createFleet("first");
    const second = await createFleet("second");
    expect((await getFleetChoices()).selected?.id).toBe(first.id);

    await selectFleetAction(form({ fleetId: second.id }));

    expect(env.cookies.get(FLEET_COOKIE)).toBe(second.id);
    const { fleets, selected } = await getFleetChoices();
    expect(selected?.id).toBe(second.id);
    expect(fleets.map((f) => f.name)).toEqual(["first", "second"]);
  });

  it("ignores a pick of a fleet that doesn't exist", async () => {
    await createFleet("only");
    await selectFleetAction(form({ fleetId: randomUUID() }));
    expect(env.cookies.has(FLEET_COOKIE)).toBe(false);
  });

  it("falls back to the oldest fleet when the remembered one is gone", async () => {
    const kept = await createFleet("kept");
    env.cookies.set(FLEET_COOKIE, randomUUID());
    expect((await getFleetChoices()).selected?.id).toBe(kept.id);
  });

  it("selects nothing when there are no fleets", async () => {
    expect(await getFleetChoices()).toEqual({ fleets: [], selected: null });
  });
});
