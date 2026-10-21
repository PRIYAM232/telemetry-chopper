"use client";

import { startTransition, useActionState, useEffect, useRef, useState, useTransition } from "react";
import {
  errorClass,
  Field,
  inputClass,
  primaryButtonClass,
  successClass,
} from "@/app/dashboard/form-ui";
import { MIN_PASSWORD_LENGTH } from "@/lib/password-policy";
import { addOperator, removeOperator, type AddOperatorState } from "./actions";

const initialState: AddOperatorState = { error: null, added: null };

export function AddOperatorForm() {
  const [state, formAction, pending] = useActionState(addOperator, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.added) formRef.current?.reset();
  }, [state]);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Email">
          <input name="email" type="email" required autoComplete="off" className={inputClass} />
        </Field>
        <Field label="Name (optional)">
          <input name="name" maxLength={100} autoComplete="off" className={inputClass} />
        </Field>
      </div>
      <Field label="Temporary password">
        <input
          name="password"
          type="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          className={inputClass}
        />
      </Field>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        At least {MIN_PASSWORD_LENGTH} characters. Share it with them privately; they choose
        their own password the first time they sign in.
      </p>
      {state.error && (
        <p role="alert" className={errorClass}>
          {state.error}
        </p>
      )}
      {state.added && !pending && (
        <p role="status" className={successClass}>
          Added {state.added}.
        </p>
      )}
      <button type="submit" disabled={pending} className={`self-start ${primaryButtonClass}`}>
        Add operator
      </button>
    </form>
  );
}

export function RemoveOperatorButton({ operatorId, email }: { operatorId: string; email: string }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startRemove] = useTransition();

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950"
      >
        Remove
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-600 dark:text-zinc-400">Remove {email}?</span>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startRemove(async () => {
              const result = await removeOperator(operatorId);
              if (!result.ok) setError(result.error);
            })
          }
          className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-500 disabled:cursor-wait disabled:opacity-40"
        >
          Remove
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setConfirming(false);
            setError(null);
          }}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
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
