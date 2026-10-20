// Fleets: creating them, rotating their keys, and which one the console is
// showing.
//
// Rotation can keep the replaced key valid for a grace period, so collectors
// can be moved to the new key one at a time without missing a policy poll or
// a heartbeat. Rotating again during a grace period ends it: only the key
// being replaced stays valid, never two old ones.

import { randomUUID } from "node:crypto";
import { fleetKeyHint, generateFleetKey, hashFleetKey } from "@/lib/fleet-keys";
import { prisma } from "@/lib/prisma";

/** Creates a fleet with a fresh key. The key is in the result and nowhere else. */
export async function createFleet(input: { name: string; description: string | null }) {
  const key = generateFleetKey();
  const fleet = await prisma.collectorFleet.create({
    data: {
      id: randomUUID(),
      name: input.name,
      description: input.description,
      apiKeyHash: hashFleetKey(key),
      apiKeyHint: fleetKeyHint(key),
    },
    select: { id: true, name: true },
  });
  return { fleet, key };
}

export type RotateResult =
  | { ok: true; key: string; name: string; previousKeyExpiresAt: Date | null }
  | { ok: false; reason: "not_found" | "conflict" };

/**
 * Replaces the fleet's key. With graceSeconds > 0 the replaced key keeps
 * working until then; with 0 it stops working now.
 */
export async function rotateFleetKey(
  fleetId: string,
  graceSeconds: number,
  now = new Date(),
): Promise<RotateResult> {
  const fleet = await prisma.collectorFleet.findUnique({
    where: { id: fleetId },
    select: { name: true, apiKeyHash: true, apiKeyHint: true },
  });
  if (!fleet) return { ok: false, reason: "not_found" };

  const key = generateFleetKey();
  const previousKeyExpiresAt = graceSeconds > 0 ? new Date(now.getTime() + graceSeconds * 1000) : null;
  // Conditional on the key we read: if two operators rotate at once, one of
  // them gets a conflict instead of a key that was overwritten before anyone
  // could install it.
  const { count } = await prisma.collectorFleet.updateMany({
    where: { id: fleetId, apiKeyHash: fleet.apiKeyHash },
    data: {
      apiKeyHash: hashFleetKey(key),
      apiKeyHint: fleetKeyHint(key),
      apiKeyCreatedAt: now,
      previousApiKeyHash: previousKeyExpiresAt ? fleet.apiKeyHash : null,
      previousApiKeyHint: previousKeyExpiresAt ? fleet.apiKeyHint : null,
      previousApiKeyExpiresAt: previousKeyExpiresAt,
    },
  });
  if (count === 0) return { ok: false, reason: "conflict" };
  return { ok: true, key, name: fleet.name, previousKeyExpiresAt };
}

/** Ends the previous key's grace period now. False if there was none to end. */
export async function revokePreviousFleetKey(fleetId: string, now = new Date()): Promise<boolean> {
  const { count } = await prisma.collectorFleet.updateMany({
    where: { id: fleetId, previousApiKeyExpiresAt: { gt: now } },
    data: { previousApiKeyHash: null, previousApiKeyHint: null, previousApiKeyExpiresAt: null },
  });
  return count > 0;
}
