"use client";

import { startTransition, useActionState, useEffect, useRef, useState, useTransition } from "react";
import { errorClass, Field, inputClass, primaryButtonClass } from "@/app/dashboard/form-ui";
import {
  DEFAULT_KEY_GRACE_SECONDS,
  KEY_GRACE_PERIODS,
  MAX_FLEET_DESCRIPTION_LENGTH,
  MAX_FLEET_NAME_LENGTH,
} from "@/lib/fleet-keys";
import {
  createFleetAction,
  revokePreviousKeyAction,
  rotateFleetKeyAction,
  type FleetKeyState,
  type IssuedKey,
} from "./actions";

const initialState: FleetKeyState = { error: null, issued: null };

const secondaryButtonClass =
  "rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-wait disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";

const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          // Clipboard access needs a secure context; the text is selectable.
        }
      }}
      className={secondaryButtonClass}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/**
 * The one time a key is visible. Dismissing it, or leaving the page, loses
 * it for good: only its hash is stored.
 */
function IssuedKeyPanel({ issued, onDismiss }: { issued: IssuedKey; onDismiss: () => void }) {
  // Where the collectors reach this control plane is a guess from here; the
  // operator replaces it when collectors use an internal address. Only ever
  // rendered after an action returns, so always in the browser.
  const origin = typeof window === "undefined" ? "http://<control-plane>:3000" : window.location.origin;
  const config = [
    "processors:",
    "  chopper_filter:",
    `    sync_endpoint: ${origin}/api/v1/policies/${issued.fleetId}`,
    `    stats_endpoint: ${origin}/api/v1/telemetry/${issued.fleetId}/stats`,
    "    fleet_key: ${env:CHOPPER_FLEET_KEY}",
  ].join("\n");

  return (
    <div
      role="status"
      className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950"
    >
      <p className="font-medium text-amber-900 dark:text-amber-200">
        New key for {issued.fleetName}. Copy it now: it won&apos;t be shown again.
      </p>
      <div className="flex items-center gap-2">
        <input
          readOnly
          value={issued.key}
          aria-label="Fleet key"
          onFocus={(e) => e.currentTarget.select()}
          className={`${inputClass} font-mono text-xs`}
        />
        <CopyButton text={issued.key} />
      </div>
      <p className="text-xs text-amber-900 dark:text-amber-200">
        {issued.previousKeyExpiresAt
          ? `The previous key keeps working until ${dateFmt.format(new Date(issued.previousKeyExpiresAt))}. Give every collector the new key before then.`
          : "Give it to this fleet's collectors, for example in the CHOPPER_FLEET_KEY environment variable:"}
      </p>
      <div className="flex items-start gap-2">
        <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded-lg bg-zinc-900 p-3 font-mono text-xs text-zinc-100">
          {config}
        </pre>
        <CopyButton text={config} />
      </div>
      <button type="button" onClick={onDismiss} className={`self-start ${secondaryButtonClass}`}>
        I&apos;ve saved the key
      </button>
    </div>
  );
}

export function CreateFleetForm() {
  const [state, formAction, pending] = useActionState(createFleetAction, initialState);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.issued) formRef.current?.reset();
  }, [state]);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  const issued = state.issued && state.issued.key !== dismissed ? state.issued : null;

  return (
    <div className="flex flex-col gap-4">
      {issued && <IssuedKeyPanel issued={issued} onDismiss={() => setDismissed(issued.key)} />}
      <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="Name">
          <input
            name="name"
            required
            maxLength={MAX_FLEET_NAME_LENGTH}
            autoComplete="off"
            placeholder="e.g. prod-us-east gateways"
            className={inputClass}
          />
        </Field>
        <Field label="Description (optional)">
          <input
            name="description"
            maxLength={MAX_FLEET_DESCRIPTION_LENGTH}
            autoComplete="off"
            className={inputClass}
          />
        </Field>
        {state.error && (
          <p role="alert" className={errorClass}>
            {state.error}
          </p>
        )}
        <button type="submit" disabled={pending} className={`self-start ${primaryButtonClass}`}>
          Create fleet
        </button>
      </form>
    </div>
  );
}

export function RotateKeyControl({ fleetId, fleetName }: { fleetId: string; fleetName: string }) {
  const [state, formAction, pending] = useActionState(rotateFleetKeyAction, initialState);
  // The action state when the form was opened. The form stays open through
  // errors and closes once a new key comes back.
  const [openedAt, setOpenedAt] = useState<FleetKeyState | null>(null);
  const open = openedAt !== null && (state === openedAt || !state.issued);
  const setOpen = (value: boolean) => setOpenedAt(value ? state : null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  const issued = state.issued && state.issued.key !== dismissed ? state.issued : null;

  return (
    <div className="flex flex-col gap-3">
      {issued && <IssuedKeyPanel issued={issued} onDismiss={() => setDismissed(issued.key)} />}
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className={`self-start ${secondaryButtonClass}`}>
          Rotate key
        </button>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <input type="hidden" name="fleetId" value={fleetId} />
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            Generate a new key for <span className="font-medium">{fleetName}</span>. Collectors using the
            current key must be given the new one.
          </p>
          <Field label="Current key stops working">
            <select name="graceSeconds" defaultValue={DEFAULT_KEY_GRACE_SECONDS} className={inputClass}>
              {KEY_GRACE_PERIODS.map((p) => (
                <option key={p.seconds} value={p.seconds}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Choose <span className="font-medium">Immediately</span> if the key may have leaked. Collectors
            still using it keep enforcing their last rules but stop receiving rule changes and reporting
            stats until they get the new key.
          </p>
          {state.error && (
            <p role="alert" className={errorClass}>
              {state.error}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button type="submit" disabled={pending} className={primaryButtonClass}>
              Rotate key
            </button>
            <button type="button" disabled={pending} onClick={() => setOpen(false)} className={secondaryButtonClass}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export function RevokePreviousKeyButton({ fleetId, hint }: { fleetId: string; hint: string }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startRevoke] = useTransition();

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950"
      >
        Revoke now
      </button>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-zinc-600 dark:text-zinc-400">Stop accepting key …{hint} now?</span>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startRevoke(async () => {
              const result = await revokePreviousKeyAction(fleetId);
              if (!result.ok) setError(result.error);
            })
          }
          className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-500 disabled:cursor-wait disabled:opacity-40"
        >
          Revoke
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setConfirming(false);
            setError(null);
          }}
          className={secondaryButtonClass}
        >
          Cancel
        </button>
      </div>
      {error && (
        <p role="alert" className={errorClass}>
          {error}
        </p>
      )}
    </div>
  );
}
