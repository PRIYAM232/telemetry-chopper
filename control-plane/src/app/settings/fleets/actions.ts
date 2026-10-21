"use server";

// Server Actions backing /settings/fleets and the fleet picker. A key is
// returned to the browser exactly once, in the action's response; it is
// never stored, logged or written to the audit trail (only its last four
// characters are).

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { AuditAction, recordAudit } from "@/lib/audit";
import { requireOperator } from "@/lib/auth";
import {
  isKeyGracePeriod,
  MAX_FLEET_DESCRIPTION_LENGTH,
  MAX_FLEET_NAME_LENGTH,
} from "@/lib/fleet-keys";
import { FLEET_COOKIE } from "@/lib/fleet-selection";
import { createFleet, revokePreviousFleetKey, rotateFleetKey } from "@/lib/fleets";
import { prisma } from "@/lib/prisma";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/** A key just generated, for the one-time display. */
export type IssuedKey = {
  fleetId: string;
  fleetName: string;
  key: string;
  // ISO timestamp; null when the replaced key stopped working at once, or
  // for a new fleet.
  previousKeyExpiresAt: string | null;
};

export type FleetKeyState = { error: string | null; issued: IssuedKey | null };

export async function createFleetAction(
  _prev: FleetKeyState,
  formData: FormData,
): Promise<FleetKeyState> {
  const operator = await requireOperator();
  const name = formString(formData, "name").trim();
  const description = formString(formData, "description").trim();

  const fail = (error: string): FleetKeyState => ({ error, issued: null });
  if (!name) return fail("Enter a name for the fleet.");
  if (name.length > MAX_FLEET_NAME_LENGTH) {
    return fail(`Name must be at most ${MAX_FLEET_NAME_LENGTH} characters.`);
  }
  if (description.length > MAX_FLEET_DESCRIPTION_LENGTH) {
    return fail(`Description must be at most ${MAX_FLEET_DESCRIPTION_LENGTH} characters.`);
  }
  // Names aren't unique in the schema, but two fleets with one name would be
  // indistinguishable in the fleet picker.
  const clash = await prisma.collectorFleet.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
    select: { id: true },
  });
  if (clash) return fail(`A fleet named ${name} already exists.`);

  const { fleet, key } = await createFleet({ name, description: description || null });
  await recordAudit({
    operator,
    action: AuditAction.FLEET_CREATED,
    fleetId: fleet.id,
    targetId: fleet.id,
    targetName: fleet.name,
    details: { keyHint: key.slice(-4) },
  });

  revalidatePath("/settings/fleets");
  return {
    error: null,
    issued: { fleetId: fleet.id, fleetName: fleet.name, key, previousKeyExpiresAt: null },
  };
}

export async function rotateFleetKeyAction(
  _prev: FleetKeyState,
  formData: FormData,
): Promise<FleetKeyState> {
  const operator = await requireOperator();
  const fleetId = formString(formData, "fleetId");
  // Number("") is 0, which means "revoke the current key now": a missing
  // field must be an error, not the most disruptive choice.
  const graceField = formString(formData, "graceSeconds");
  const graceSeconds = /^\d+$/.test(graceField) ? Number(graceField) : NaN;

  const fail = (error: string): FleetKeyState => ({ error, issued: null });
  if (!UUID_RE.test(fleetId)) return fail("Invalid fleet id.");
  if (!isKeyGracePeriod(graceSeconds)) return fail("Choose when the current key stops working.");

  const result = await rotateFleetKey(fleetId, graceSeconds);
  if (!result.ok) {
    return fail(
      result.reason === "not_found"
        ? "Fleet not found."
        : "Someone else rotated this fleet's key just now. Reload the page to see it.",
    );
  }
  await recordAudit({
    operator,
    action: AuditAction.FLEET_KEY_ROTATED,
    fleetId,
    targetId: fleetId,
    targetName: result.name,
    details: {
      keyHint: result.key.slice(-4),
      graceSeconds,
      previousKeyExpiresAt: result.previousKeyExpiresAt?.toISOString() ?? null,
    },
  });

  revalidatePath("/settings/fleets");
  return {
    error: null,
    issued: {
      fleetId,
      fleetName: result.name,
      key: result.key,
      previousKeyExpiresAt: result.previousKeyExpiresAt?.toISOString() ?? null,
    },
  };
}

export type RevokeResult = { ok: true } | { ok: false; error: string };

export async function revokePreviousKeyAction(fleetId: string): Promise<RevokeResult> {
  const operator = await requireOperator();
  if (typeof fleetId !== "string" || !UUID_RE.test(fleetId)) {
    return { ok: false, error: "Invalid fleet id." };
  }
  const fleet = await prisma.collectorFleet.findUnique({
    where: { id: fleetId },
    select: { name: true, previousApiKeyHint: true },
  });
  if (!fleet) return { ok: false, error: "Fleet not found." };

  if (!(await revokePreviousFleetKey(fleetId))) {
    return { ok: false, error: "The previous key has already stopped working." };
  }
  await recordAudit({
    operator,
    action: AuditAction.FLEET_PREVIOUS_KEY_REVOKED,
    fleetId,
    targetId: fleetId,
    targetName: fleet.name,
    details: { keyHint: fleet.previousApiKeyHint },
  });

  revalidatePath("/settings/fleets");
  return { ok: true };
}

/** The fleet picker: remembers the choice and re-renders the page with it. */
export async function selectFleetAction(formData: FormData): Promise<void> {
  await requireOperator();
  const fleetId = formString(formData, "fleetId");
  if (!UUID_RE.test(fleetId)) return;
  const exists = await prisma.collectorFleet.count({ where: { id: fleetId } });
  if (!exists) return;

  (await cookies()).set(FLEET_COOKIE, fleetId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 365 * 24 * 60 * 60,
  });
  revalidatePath("/", "layout");
}
