"use client";

// The cloud egress form: an on/off toggle, the provider's outbound transfer
// price, and the exporter's wire compression ratio. Same submit pattern as
// the other pricing forms — onSubmit, never a React form reset.

import { startTransition, useActionState, useState } from "react";
import { Field, inputClass } from "@/app/dashboard/form-ui";
import type { EgressConfig } from "@/lib/egress";
import { saveEgressAction, type SaveEgressState } from "./actions";

const initialState: SaveEgressState = { error: null, savedAt: null };

export function EgressForm({ fleetId, config }: { fleetId: string; config: EgressConfig }) {
  const [state, formAction, pending] = useActionState(saveEgressAction, initialState);
  const [enabled, setEnabled] = useState(config.enabled);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <input type="hidden" name="fleetId" value={fleetId} />

      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          name="enabled"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-zinc-900 dark:accent-zinc-100"
        />
        <span className="text-sm text-zinc-700 dark:text-zinc-300">
          <span className="font-medium text-zinc-900 dark:text-zinc-100">
            Include cloud egress savings
          </span>
          <span className="block text-xs text-zinc-500 dark:text-zinc-400">
            Turn on if your collectors send telemetry out of their cloud network (to the
            internet or another region) to reach your vendor. Leave off for same-region
            private links, where telemetry pays no egress.
          </span>
        </span>
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Egress price (USD / GB)">
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-zinc-400">
              $
            </span>
            <input
              name="egressPricePerGb"
              required
              inputMode="decimal"
              pattern="\d{1,6}(\.\d{1,4})?"
              title="USD per GB transferred out, up to 4 decimal places (e.g. 0.09)"
              defaultValue={String(config.pricePerGb)}
              disabled={!enabled}
              className={`${inputClass} pl-7 tabular-nums disabled:opacity-50`}
            />
          </div>
        </Field>
        <Field label="Wire compression ratio">
          <input
            name="compressionRatio"
            required
            inputMode="decimal"
            pattern="\d{1,4}(\.\d{1,2})?(:1)?"
            title="Uncompressed ÷ compressed size, e.g. 4 for 4:1. 1 = no compression."
            defaultValue={String(config.compressionRatio)}
            disabled={!enabled}
            className={`${inputClass} tabular-nums disabled:opacity-50`}
          />
        </Field>
      </div>
      {/* Disabled inputs aren't submitted, so carry the saved values while
          the toggle is off: switching egress off must not wipe the rate. */}
      {!enabled && (
        <>
          <input type="hidden" name="egressPricePerGb" value={String(config.pricePerGb)} />
          <input type="hidden" name="compressionRatio" value={String(config.compressionRatio)} />
        </>
      )}
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Standard AWS internet egress starts at $0.09/GB; use the rate for the path your
        telemetry actually takes. Providers bill compressed bytes on the wire, while
        Chopper measures uncompressed OTLP. OTLP exporters gzip by default, so enter the
        ratio you observe (e.g. 4 for 4:1), or 1 if you send uncompressed.
      </p>

      {state.error && (
        <p
          role="alert"
          className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs break-words text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-400"
        >
          {state.error}
        </p>
      )}
      {state.error === null && state.savedAt !== null && !pending && (
        <p
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-400"
        >
          Egress settings saved.{" "}
          {enabled
            ? "The dashboard now adds egress savings to the total."
            : "Egress savings are off."}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-opacity hover:bg-zinc-700 disabled:cursor-wait disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        Save egress settings
      </button>
    </form>
  );
}
