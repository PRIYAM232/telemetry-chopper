import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashFleetKey } from "@/lib/fleet-keys";
import { createFleet, revokePreviousFleetKey, rotateFleetKey } from "@/lib/fleets";
import { prisma } from "@/lib/prisma";

const HOUR = 3600;

afterEach(() => {
  vi.restoreAllMocks();
});

const row = (id: string) => prisma.collectorFleet.findUniqueOrThrow({ where: { id } });

describe("createFleet", () => {
  it("returns a fresh key and stores only its hash and last four characters", async () => {
    const { fleet, key } = await createFleet({ name: "payments", description: "PCI gateways" });

    expect(key).toMatch(/^chopper_sk_[A-Za-z0-9_-]{43}$/);
    const stored = await row(fleet.id);
    expect(stored).toMatchObject({
      name: "payments",
      description: "PCI gateways",
      apiKeyHash: hashFleetKey(key),
      apiKeyHint: key.slice(-4),
      previousApiKeyHash: null,
    });
  });

  it("gives every fleet a different key", async () => {
    const a = await createFleet({ name: "a", description: null });
    const b = await createFleet({ name: "b", description: null });
    expect(a.key).not.toBe(b.key);
  });
});

describe("rotateFleetKey", () => {
  it("replaces the key and keeps the old one valid for the grace period", async () => {
    const { fleet, key: oldKey } = await createFleet({ name: "f", description: null });
    const now = new Date("2026-10-20T12:00:00Z");

    const result = await rotateFleetKey(fleet.id, 24 * HOUR, now);

    if (!result.ok) throw new Error("rotation failed");
    expect(result.key).not.toBe(oldKey);
    expect(result.previousKeyExpiresAt).toEqual(new Date("2026-10-21T12:00:00Z"));
    expect(await row(fleet.id)).toMatchObject({
      apiKeyHash: hashFleetKey(result.key),
      apiKeyHint: result.key.slice(-4),
      apiKeyCreatedAt: now,
      previousApiKeyHash: hashFleetKey(oldKey),
      previousApiKeyHint: oldKey.slice(-4),
      previousApiKeyExpiresAt: new Date("2026-10-21T12:00:00Z"),
    });
  });

  it("keeps no previous key when the grace period is zero", async () => {
    const { fleet } = await createFleet({ name: "f", description: null });
    const result = await rotateFleetKey(fleet.id, 0);
    expect(result).toMatchObject({ ok: true, previousKeyExpiresAt: null });
    expect(await row(fleet.id)).toMatchObject({ previousApiKeyHash: null, previousApiKeyExpiresAt: null });
  });

  it("rotating again during a grace period leaves only the key just replaced valid", async () => {
    const { fleet, key: first } = await createFleet({ name: "f", description: null });
    const second = await rotateFleetKey(fleet.id, HOUR);
    const third = await rotateFleetKey(fleet.id, HOUR);
    if (!second.ok || !third.ok) throw new Error("rotation failed");

    const stored = await row(fleet.id);
    expect(stored.apiKeyHash).toBe(hashFleetKey(third.key));
    expect(stored.previousApiKeyHash).toBe(hashFleetKey(second.key));
    expect([stored.apiKeyHash, stored.previousApiKeyHash]).not.toContain(hashFleetKey(first));
  });

  it("reports a conflict instead of overwriting a key someone else just rotated in", async () => {
    const { fleet } = await createFleet({ name: "f", description: null });
    const before = await row(fleet.id);
    // The read sees a key that has already been replaced.
    vi.spyOn(prisma.collectorFleet, "findUnique").mockResolvedValueOnce({
      name: "f",
      apiKeyHash: hashFleetKey("a key rotated out meanwhile"),
      apiKeyHint: "hile",
    } as never);

    expect(await rotateFleetKey(fleet.id, HOUR)).toEqual({ ok: false, reason: "conflict" });
    expect((await row(fleet.id)).apiKeyHash).toBe(before.apiKeyHash);
  });

  it("reports an unknown fleet", async () => {
    expect(await rotateFleetKey(randomUUID(), HOUR)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("revokePreviousFleetKey", () => {
  it("ends the grace period now", async () => {
    const { fleet } = await createFleet({ name: "f", description: null });
    await rotateFleetKey(fleet.id, HOUR);

    expect(await revokePreviousFleetKey(fleet.id)).toBe(true);
    expect(await row(fleet.id)).toMatchObject({
      previousApiKeyHash: null,
      previousApiKeyHint: null,
      previousApiKeyExpiresAt: null,
    });
  });

  it("returns false when no previous key is still valid", async () => {
    const { fleet } = await createFleet({ name: "f", description: null });
    expect(await revokePreviousFleetKey(fleet.id)).toBe(false);

    await rotateFleetKey(fleet.id, HOUR, new Date(Date.now() - 2 * HOUR * 1000));
    expect(await revokePreviousFleetKey(fleet.id)).toBe(false);
  });
});
