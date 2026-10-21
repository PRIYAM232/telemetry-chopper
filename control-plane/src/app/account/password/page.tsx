// /account/password — change your own password. Operators whose password
// someone else chose (the first operator from the environment, or one added
// on /settings/operators) land here after signing in and can't reach the
// rest of the console until they pick their own.

import type { Metadata } from "next";
import { TopBar } from "@/app/top-bar";
import { requireOperator, safeNextPath } from "@/lib/auth";
import { PasswordForm } from "./password-form";
import { signOut } from "@/app/login/actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Change password — Telemetry Chopper",
};

export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const operator = await requireOperator({ allowPendingPasswordChange: true });
  const rawNext = (await searchParams).next;
  const next = safeNextPath(Array.isArray(rawNext) ? rawNext[0] : rawNext);
  const forced = operator.mustChangePassword;

  return (
    <>
      {!forced && <TopBar operator={operator} current={null} />}
      <main className="mx-auto w-full max-w-md flex-1 px-4 py-12">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          {forced ? "Choose your password" : "Change password"}
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          {forced ? (
            <>
              Signed in as <span className="font-medium">{operator.email}</span> with a password
              someone else set. Choose your own to continue.
            </>
          ) : (
            <>
              Signed in as <span className="font-medium">{operator.email}</span>.
            </>
          )}
        </p>
        <div className="mt-6 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <PasswordForm email={operator.email} next={next} />
        </div>
        {forced && (
          <form action={signOut} className="mt-4">
            <button
              type="submit"
              className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              Sign out
            </button>
          </form>
        )}
      </main>
    </>
  );
}
