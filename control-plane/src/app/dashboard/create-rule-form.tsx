"use client";

// The New rule form. A client component so createRule's validation errors
// (e.g. a regex Go's RE2 rejects) render inline via useActionState instead of
// surfacing as a generic error page.
//
// Submitted through onSubmit rather than <form action>: React resets a form
// after every action it runs, which would wipe the operator's input exactly
// when it needs fixing. After a successful save the form clears
// consistently: every select (Action, Signal, Operator) keeps its value for
// the next rule, every typed field clears (issue #16).

import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { ConditionOp, PolicyAction, SampleScope } from "@/generated/prisma/enums";
import { ActionFields } from "./action-fields";
import { createRule, type CreateRuleState } from "./actions";
import { IGNORE_CASE_OPS } from "@/lib/conditions";
import { Field, inputClass } from "./form-ui";

const initialState: CreateRuleState = { error: null };

export function CreateRuleForm({ fleetId }: { fleetId: string }) {
  const [state, formAction, pending] = useActionState(createRule, initialState);
  const formRef = useRef<HTMLFormElement>(null);
  // Controlled so the post-save reset keeps it, like Action and Signal.
  const [conditionOp, setConditionOp] = useState<string>(ConditionOp.EQUALS);
  // Controlled like the selects, so it carries over to the next rule too.
  const [ignoreCase, setIgnoreCase] = useState(false);
  // Lifted out of ActionFields: a whole-trace SAMPLE rule has no condition
  // (issue #45), so the Condition inputs below depend on both.
  const [action, setAction] = useState<string>(PolicyAction.DROP);
  const [sampleScope, setSampleScope] = useState<string>(SampleScope.TRACE);
  const hasCondition = !(action === PolicyAction.SAMPLE && sampleScope === SampleScope.TRACE);

  useEffect(() => {
    // Every completed submission returns a fresh state object, so this runs
    // once per save; skip the initial render.
    // Clear the typed inputs only — never reset the whole form. A form reset
    // (form.reset() or React's requestFormReset) puts each <select> back on
    // its initial option in the DOM without touching React state, so the
    // Action select showed DROP while ActionFields still rendered the
    // previous action's inputs, and the next submit sent the stale DOM
    // value. The typed inputs are uncontrolled, so clearing their DOM value
    // is the whole job; the selects are controlled and simply keep theirs.
    const form = formRef.current;
    if (form && state !== initialState && state.error === null) {
      // Checkboxes are skipped: clearing a checkbox's value would make it
      // submit "" instead of "on".
      for (const input of form.querySelectorAll<HTMLInputElement>(
        "input:not([type=hidden]):not([type=checkbox])",
      )) {
        input.value = "";
      }
      form.querySelector<HTMLInputElement>("input[name=name]")?.focus();
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
      <ActionFields
        action={action}
        onActionChange={setAction}
        sampleScope={sampleScope}
        onSampleScopeChange={setSampleScope}
      />
      {hasCondition && (
        <Field label="Condition">
          <div className="flex flex-col gap-2">
            <input
              name="conditionField"
              required
              placeholder="http.status_code"
              className={inputClass}
            />
            <div className="grid grid-cols-2 gap-2">
              <select
                name="conditionOp"
                value={conditionOp}
                onChange={(e) => setConditionOp(e.target.value)}
                className={inputClass}
              >
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
            {IGNORE_CASE_OPS.has(conditionOp) && (
              <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                <input
                  type="checkbox"
                  name="conditionIgnoreCase"
                  value="on"
                  checked={ignoreCase}
                  onChange={(e) => setIgnoreCase(e.target.checked)}
                  className="h-3.5 w-3.5 accent-zinc-900 dark:accent-zinc-100"
                />
                {/* One flex item, so the text wraps as a sentence. */}
                <span>
                  Ignore case (matches <code className="font-mono">INFO</code>,{" "}
                  <code className="font-mono">info</code> and{" "}
                  <code className="font-mono">Info</code>)
                </span>
              </label>
            )}
          </div>
        </Field>
      )}
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
