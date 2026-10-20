"use client";

// Switches the fleet the dashboard and pricing pages show. Rendered in place
// of the fleet's name when there is more than one fleet.

import { useTransition } from "react";
import type { FleetChoice } from "@/lib/fleet-selection";
import { selectFleetAction } from "./actions";

export function FleetPicker({ fleets, selectedId }: { fleets: FleetChoice[]; selectedId: string }) {
  const [pending, startSelect] = useTransition();
  return (
    // Uncontrolled, so the new choice stays shown while the page re-renders;
    // the key resets it if the selection changes some other way.
    <select
      key={selectedId}
      aria-label="Fleet"
      defaultValue={selectedId}
      disabled={pending}
      onChange={(e) => {
        const formData = new FormData();
        formData.set("fleetId", e.currentTarget.value);
        startSelect(() => selectFleetAction(formData));
      }}
      className="rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-sm font-medium text-zinc-900 disabled:cursor-wait disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
    >
      {fleets.map((f) => (
        <option key={f.id} value={f.id}>
          {f.name}
        </option>
      ))}
    </select>
  );
}
