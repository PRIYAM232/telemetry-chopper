"use client";

// The New rule form. A client component so createRule's validation errors
// (e.g. a regex Go's RE2 rejects) render inline via useActionState instead of
// surfacing as a generic error page.
//
// Submitted through onSubmit rather than <form action>: React resets a form
// after every action it runs, which would wipe the operator's input exactly
// when it needs fixing. Here the form resets only after a successful save.

import { startTransition, useActionState, useEffect, useRef } from "react";
import { requestFormReset } from "react-dom";
import { ConditionOp } from "@/generated/prisma/enums";
import { ActionFields } from "./action-fields";
import { createRule, type CreateRuleState } from "./actions";
import { Field, inputClass } from "./form-ui";

const initialState: CreateRuleState = { error: null };

export function CreateRuleForm({ fleetId }: { fleetId: string }) {
  const [state, formAction, pending] = useActionState(createRule, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    // Every completed submission returns a fresh state object, so this runs
    // once per save; skip the initial render.
    // requestFormReset, not form.reset(): it is the reset React itself runs
    // after a form action, which re-applies controlled values (the Action
    // select in ActionFields) instead of leaving the DOM out of sync.
    const form = formRef.current;
    if (form && state !== initialState && state.error === null) {
      startTransition(() => requestFormReset(form));
    }
  }, [state]);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="mt-3 flex flex-col gap-3">
      <input type="hidden" name="fleetId" value={fleetId} />
      <Field label="Name">
        <input
          name="name"
          required
          placeholder="drop-staging-noise"
          className={inputClass}
        />
      </Field>
      {/* Action + signal selects and the action-specific inputs
          (sample rate, route destination) — the extra input only appears
          for the action that needs it. */}
      <ActionFields />
      <Field label="Condition">
        <div className="flex flex-col gap-2">
          <input
            name="conditionField"
            required
            placeholder="http.status_code"
            className={inputClass}
          />
          <div className="grid grid-cols-2 gap-2">
            <select name="conditionOp" defaultValue={ConditionOp.EQUALS} className={inputClass}>
              {Object.values(ConditionOp).map((op) => (
                <option key={op} value={op}>{op}</option>
              ))}
            </select>
            <input
              name="conditionValue"
              placeholder="404 · regex for REGEX_MATCH · blank for EXISTS"
              className={inputClass}
            />
          </div>
        </div>
      </Field>
      {state.error && (
        <p
          role="alert"
          className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs break-words text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-400"
        >
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="mt-1 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-opacity hover:bg-zinc-700 disabled:cursor-wait disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        Create rule
      </button>
    </form>
  );
}
