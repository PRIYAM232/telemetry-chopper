"use client";

import { startTransition, useActionState, useEffect, useRef } from "react";
import {
  errorClass,
  Field,
  inputClass,
  primaryButtonClass,
  successClass,
} from "@/app/dashboard/form-ui";
import { MIN_PASSWORD_LENGTH } from "@/lib/password-policy";
import { changePassword, type ChangePasswordState } from "./actions";

const initialState: ChangePasswordState = { error: null, savedAt: null };

export function PasswordForm({ email, next }: { email: string; next: string }) {
  const [state, formAction, pending] = useActionState(changePassword, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  // Clear the password fields once the change is saved.
  useEffect(() => {
    if (state.savedAt !== null) formRef.current?.reset();
  }, [state.savedAt]);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      {/* Lets password managers attach the new password to this account. */}
      <input type="hidden" name="username" autoComplete="username" value={email} />
      <Field label="Current password">
        <input
          name="currentPassword"
          type="password"
          required
          autoComplete="current-password"
          className={inputClass}
        />
      </Field>
      <Field label="New password">
        <input
          name="newPassword"
          type="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          className={inputClass}
        />
      </Field>
      <Field label="Confirm new password">
        <input
          name="confirmPassword"
          type="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          className={inputClass}
        />
      </Field>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        At least {MIN_PASSWORD_LENGTH} characters. Changing it signs out your other browsers.
      </p>
      {state.error && (
        <p role="alert" className={errorClass}>
          {state.error}
        </p>
      )}
      {state.error === null && state.savedAt !== null && !pending && (
        <p role="status" className={successClass}>
          Password changed.
        </p>
      )}
      <button type="submit" disabled={pending} className={`self-start ${primaryButtonClass}`}>
        Change password
      </button>
    </form>
  );
}
