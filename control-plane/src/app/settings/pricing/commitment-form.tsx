"use client";

// The volume commitment form: monthly committed GB, the overage multiplier,
// and the billing cycle start day. Same submit pattern as PricingForm —
// onSubmit, never a React form reset, so a rejected value stays editable.

import { startTransition, useActionState } from "react";
import { Field, inputClass } from "@/app/dashboard/form-ui";
import type { Commitment } from "@/lib/overage";
import { saveCommitmentAction, type SaveCommitmentState } from "./actions";

const initialState: SaveCommitmentState = { error: null, savedAt: null };

export function CommitmentForm({
  fleetId,
  commitment,
}: {
  fleetId: string;
  commitment: Commitment | null;
}) {
  const [state, formAction, pending] = useActionState(saveCommitmentAction, initialState);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <input type="hidden" name="fleetId" value={fleetId} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Committed volume (GB / month)">
          <input
            name="committedGbPerMonth"
            required
            inputMode="decimal"
            pattern="[\d,]{1,15}(\.\d{1,3})?"
            title="GB per billing month, e.g. 5000"
            defaultValue={commitment ? String(commitment.committedGbPerMonth) : ""}
            placeholder="5000"
            className={`${inputClass} tabular-nums`}
          />
        </Field>
        <Field label="Overage multiplier">
          <input
            name="overageMultiplier"
            required
            inputMode="decimal"
            list="overage-multipliers"
            pattern="\d{1,3}(\.\d{1,2})?[xX]?"
            title="Overage price as a multiple of your rate card, e.g. 1.5"
            defaultValue={commitment ? String(commitment.overageMultiplier) : ""}
            placeholder="1.5"
            className={`${inputClass} tabular-nums`}
          />
          <datalist id="overage-multipliers">
            <option value="1">Standard rate (no penalty)</option>
            <option value="1.25" />
            <option value="1.5" />
            <option value="2" />
          </datalist>
        </Field>
        <Field label="Billing cycle starts on day">
          <input
            name="billingCycleDay"
            required
            type="number"
            min={1}
            max={28}
            step={1}
            defaultValue={commitment?.billingCycleDay ?? 1}
            className={`${inputClass} tabular-nums`}
          />
        </Field>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Traffic past the committed volume is priced at your rate card × the multiplier
        (1.5 = 150%). Billing periods run in UTC.
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
          Commitment saved. The dashboard now tracks this billing period against it.
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-opacity hover:bg-zinc-700 disabled:cursor-wait disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        Save commitment
      </button>
    </form>
  );
}
