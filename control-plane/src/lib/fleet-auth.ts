// Fleet-scoped bearer authentication, shared by every /api/v1 route the data
// plane calls (policy pull, telemetry stats push).
//
// Security notes:
//   - The presented key is hashed and compared against the stored SHA-256
//     (src/lib/fleet-keys.ts) in constant time (timingSafeEqual), so response
//     timing leaks nothing about the key.
//   - Unknown fleet and wrong key both return the same 401 so the endpoints
//     cannot be used to enumerate fleet IDs.
//   - A key rotated out with a grace period is accepted until the period
//     ends, and the result says so, so heartbeats can record which collectors
//     still need the new key.

import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { hashFleetKey } from "@/lib/fleet-keys";
import { prisma } from "@/lib/prisma";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Both sides are hex SHA-256 digests, so always the same length; the check
// only keeps timingSafeEqual from throwing on a malformed stored value.
function digestsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function unauthorized(): NextResponse {
  return NextResponse.json(
    { error: "invalid fleet credentials" },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

export type FleetAuthResult =
  | { ok: true; fleetId: string; usedPreviousKey: boolean }
  | { ok: false; response: NextResponse };

/**
 * Validates the fleetId path segment and the `Authorization: Bearer` header
 * against the fleet's key (or its previous key, during a rotation's grace period). On failure, `response` is ready to return
 * as-is (400 for a malformed fleetId, 401 for anything credential-shaped).
 */
export async function authenticateFleet(
  request: NextRequest,
  fleetId: string,
): Promise<FleetAuthResult> {
  if (!UUID_RE.test(fleetId)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "fleetId must be a UUID" },
        { status: 400 },
      ),
    };
  }

  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!bearer) {
    return { ok: false, response: unauthorized() };
  }

  const fleet = await prisma.collectorFleet.findUnique({
    where: { id: fleetId },
    select: { id: true, apiKeyHash: true, previousApiKeyHash: true, previousApiKeyExpiresAt: true },
  });
  if (!fleet) {
    return { ok: false, response: unauthorized() };
  }

  const presented = hashFleetKey(bearer);
  if (digestsEqual(presented, fleet.apiKeyHash)) {
    return { ok: true, fleetId: fleet.id, usedPreviousKey: false };
  }
  if (
    fleet.previousApiKeyHash &&
    fleet.previousApiKeyExpiresAt &&
    fleet.previousApiKeyExpiresAt.getTime() > Date.now() &&
    digestsEqual(presented, fleet.previousApiKeyHash)
  ) {
    return { ok: true, fleetId: fleet.id, usedPreviousKey: true };
  }
  return { ok: false, response: unauthorized() };
}
