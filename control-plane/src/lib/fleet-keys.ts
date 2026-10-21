// Fleet keys: the secret a fleet's collectors present as
// `Authorization: Bearer <key>`. Pure helpers, no database access, so the
// seed script can use them too; creating and rotating live in
// src/lib/fleets.ts.
//
// A key is shown to the operator once, when it is generated, and stored only
// as its SHA-256. Keys are 256 random bits, so a fast hash is enough: there is
// nothing to brute-force, unlike a password. Sessions use the same scheme
// (src/lib/auth.ts).

import { createHash, randomBytes } from "node:crypto";

const KEY_PREFIX = "chopper_sk_";
const HINT_LENGTH = 4;

export const MAX_FLEET_NAME_LENGTH = 100;
export const MAX_FLEET_DESCRIPTION_LENGTH = 500;

/** How long a rotated-out key keeps working, as offered on the Fleets page. */
export const KEY_GRACE_PERIODS = [
  { seconds: 0, label: "Immediately" },
  { seconds: 60 * 60, label: "After 1 hour" },
  { seconds: 24 * 60 * 60, label: "After 24 hours" },
  { seconds: 7 * 24 * 60 * 60, label: "After 7 days" },
] as const;

export const DEFAULT_KEY_GRACE_SECONDS = 24 * 60 * 60;

export function isKeyGracePeriod(seconds: number): boolean {
  return KEY_GRACE_PERIODS.some((p) => p.seconds === seconds);
}

export function generateFleetKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("base64url");
}

export function hashFleetKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function fleetKeyHint(key: string): string {
  return key.slice(-HINT_LENGTH);
}
