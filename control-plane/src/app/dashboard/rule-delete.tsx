"use client";

// Rule deletion with a confirmation step and an undo toast (issue #12).
//
// DeleteRuleButton opens a modal <dialog> naming the rule and offering
// Pause, the reversible alternative, before the destructive action. A
// confirmed delete is a soft delete (see deleteRule): the card disappears,
// and RuleToaster, mounted once per page outside the rule cards (which
// unmount on delete), announces it with an Undo button.

import { useEffect, useRef, useState, useTransition } from "react";
import { deleteRule, restoreRule, toggleRuleActive } from "./actions";

const DELETED_EVENT = "chopper:rule-deleted";
const TOAST_MS = 15_000;

type DeletedDetail = { ruleId: string; name: string };

const buttonBase =
  "rounded-lg px-3 py-1.5 text-sm font-medium transition-opacity disabled:cursor-wait disabled:opacity-40";

export function DeleteRuleButton({
  ruleId,
  name,
  isActive,
}: {
  ruleId: string;
  name: string;
  isActive: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const close = () => dialogRef.current?.close();

  const confirmDelete = () => {
    setError(null);
    startTransition(async () => {
      const result = await deleteRule(ruleId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      close();
      window.dispatchEvent(
        new CustomEvent<DeletedDetail>(DELETED_EVENT, { detail: { ruleId, name: result.name } }),
      );
    });
  };

  const pauseInstead = () => {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("ruleId", ruleId);
      await toggleRuleActive(fd);
      close();
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null);
          dialogRef.current?.showModal();
        }}
        className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950"
      >
        Delete
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby={`delete-title-${ruleId}`}
        className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-zinc-200 bg-white p-0 text-left text-zinc-900 shadow-xl backdrop:bg-zinc-950/40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
      >
        <div className="p-5">
          <h2 id={`delete-title-${ruleId}`} className="text-base font-semibold">
            Delete “{name}”?
          </h2>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            Collectors stop enforcing it on their next policy poll (about 10 seconds), and its
            match and drop history is deleted. You can undo for a short time afterwards.
          </p>
          {isActive && (
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
              <span className="font-medium text-zinc-900 dark:text-zinc-100">Pause</span> stops
              enforcement the same way but keeps the rule and its history.
            </p>
          )}
          {error !== null && (
            <p role="alert" className="mt-3 text-sm text-rose-600 dark:text-rose-400">
              {error}
            </p>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-200 bg-zinc-50 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900/50">
          {/* Cancel takes initial focus: Enter on an opened dialog must not delete. */}
          <button
            type="button"
            autoFocus
            onClick={close}
            disabled={pending}
            className={`${buttonBase} border border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800`}
          >
            Cancel
          </button>
          {isActive && (
            <button
              type="button"
              onClick={pauseInstead}
              disabled={pending}
              className={`${buttonBase} border border-zinc-300 text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800`}
            >
              Pause instead
            </button>
          )}
          <button
            type="button"
            onClick={confirmDelete}
            disabled={pending}
            className={`${buttonBase} bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-600 dark:hover:bg-rose-500`}
          >
            Delete rule
          </button>
        </div>
      </dialog>
    </>
  );
}

type Toast =
  | { kind: "deleted"; ruleId: string; name: string }
  | { kind: "restored"; name: string }
  | { kind: "error"; message: string };

// One toast at a time, bottom of the viewport, announced politely to screen
// readers. A newer delete replaces the older toast (its undo window keeps
// running server-side, but the newest action is the one worth undoing).
export function RuleToaster() {
  const [toast, setToast] = useState<Toast | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const onDeleted = (e: Event) => {
      const { ruleId, name } = (e as CustomEvent<DeletedDetail>).detail;
      setToast({ kind: "deleted", ruleId, name });
    };
    window.addEventListener(DELETED_EVENT, onDeleted);
    return () => window.removeEventListener(DELETED_EVENT, onDeleted);
  }, []);

  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), toast.kind === "deleted" ? TOAST_MS : 5_000);
    return () => clearTimeout(timer);
  }, [toast]);

  const undo = (ruleId: string) => {
    startTransition(async () => {
      const result = await restoreRule(ruleId);
      setToast(result.ok ? { kind: "restored", name: result.name } : { kind: "error", message: result.error });
    });
  };

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4"
    >
      {toast !== null && (
        <div className="pointer-events-auto flex max-w-full items-center gap-4 rounded-lg bg-zinc-900 px-4 py-3 text-sm text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900">
          <span className="min-w-0 truncate">
            {toast.kind === "deleted" && <>Deleted rule “{toast.name}”</>}
            {toast.kind === "restored" && <>Restored rule “{toast.name}”</>}
            {toast.kind === "error" && toast.message}
          </span>
          {toast.kind === "deleted" && (
            <button
              type="button"
              onClick={() => undo(toast.ruleId)}
              disabled={pending}
              className="shrink-0 font-semibold text-sky-300 underline-offset-2 hover:underline disabled:opacity-50 dark:text-sky-700"
            >
              Undo
            </button>
          )}
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Dismiss"
            className="shrink-0 text-zinc-400 hover:text-white dark:text-zinc-500 dark:hover:text-zinc-900"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
