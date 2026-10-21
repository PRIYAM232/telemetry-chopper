// Which fleet the dashboard and pricing pages show. The choice is a cookie
// set by the fleet picker (src/app/settings/fleets/actions.ts), so it
// follows the operator from page to page. Without one, or when its fleet no
// longer exists, the oldest fleet is shown: on a single-fleet deployment
// nothing changes.
//
// The cookie only picks what to display. Every Server Action still takes
// the fleet ID from its form and validates it.

import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";

export const FLEET_COOKIE = "chopper_fleet";

export type FleetChoice = { id: string; name: string };

export async function getFleetChoices(): Promise<{
  fleets: FleetChoice[];
  selected: FleetChoice | null;
}> {
  const fleets = await prisma.collectorFleet.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
  const wanted = (await cookies()).get(FLEET_COOKIE)?.value;
  const selected = fleets.find((f) => f.id === wanted) ?? fleets[0] ?? null;
  return { fleets, selected };
}
