"use client";

// Client island for the action-dependent half of the New rule form: the
// action select plus the inputs that only one action needs — sample rate for
// SAMPLE, destination for ROUTE. Rendering them conditionally (instead of the
// old always-visible "(SAMPLE only)" field) means the browser's `required`
// validation can be honest: when the field is visible, it is mandatory.
//
// Everything else stays an uncontrolled <form> feeding the createRule Server
// Action. The Action and Signal selects are controlled on purpose: after a
// successful save CreateRuleForm clears only the typed inputs, so the rule's
// "shape" (action, signal, and the operator in CreateRuleForm) carries over
// to the next rule. Filing several rules for one signal is the common case, and
// a signal silently reverting to TRACES produced rules against the wrong
// signal (issue #16).

import { useState } from "react";
import { PolicyAction, TargetSignal } from "@/generated/prisma/enums";
import { Field, inputClass } from "./form-ui";

// Suggestions only (datalist allows free text): the destinations the dev
// collector pipeline actually routes on — see the routing connector tables in
// data-plane/config/otelcol-dev.yaml. A destination with no route table entry
// falls through to the default hot pipeline.
const KNOWN_DESTINATIONS = ["cold-storage", "premium-analytics"];

export function ActionFields() {
  const [action, setAction] = useState<string>(PolicyAction.DROP);
  const [signal, setSignal] = useState<string>(TargetSignal.TRACES);

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Action">
          <select
            name="actionType"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className={inputClass}
          >
            {Object.values(PolicyAction).map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </Field>
        <Field label="Signal">
          <select
            name="targetSignal"
            value={signal}
            onChange={(e) => setSignal(e.target.value)}
            className={inputClass}
          >
            {Object.values(TargetSignal).map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </Field>
      </div>

      {action === PolicyAction.SAMPLE && (
        <Field label="Sample rate (0–1)">
          <input
            name="sampleRate"
            type="number"
            step="0.01"
            min="0.01"
            max="1"
            required
            placeholder="0.1 = keep 10% of traces"
            className={inputClass}
          />
        </Field>
      )}

      {action === PolicyAction.EXCLUDE_INDEX && (
        <p className="rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-2 text-xs text-cyan-800 dark:border-cyan-900 dark:bg-cyan-950 dark:text-cyan-300">
          Keeps matching spans or logs flowing but stamps them{" "}
          <code className="font-mono">chopper.index=false</code>. Add an index exclusion
          or retention filter on that attribute in your vendor (for example{" "}
          <code className="font-mono">@chopper.index:false</code>) so they&apos;re ingested
          but not indexed. Traces and logs only.
        </p>
      )}

      {action === PolicyAction.ROUTE && (
        <Field label="Route to destination">
          <input
            name="targetDestination"
            required
            list="chopper-known-destinations"
            placeholder="cold-storage"
            className={inputClass}
          />
          <datalist id="chopper-known-destinations">
            {KNOWN_DESTINATIONS.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </Field>
      )}

      {action === PolicyAction.THROTTLE && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Rate (events/sec)">
            <input
              name="throttleRate"
              type="number"
              step="1"
              min="1"
              required
              placeholder="100"
              className={inputClass}
            />
          </Field>
          {/* Optional on purpose: blank means one global bucket for the rule
              instead of a bucket per attribute value — see createRule. */}
          <Field label="Group by attribute">
            <input
              name="throttleGroupBy"
              placeholder="tenant_id · blank = global"
              className={inputClass}
            />
          </Field>
        </div>
      )}
    </>
  );
}
