// /login — operator sign-in (issue #10).
//
// Renders without touching the database unless the browser already has a
// session cookie, so the Docker and Kubernetes health checks (which follow
// / → /login) keep passing while PostgreSQL or the migration job is still
// starting.

import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE } from "@/lib/auth-cookie";
import { getOperator, safeNextPath } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign in — Telemetry Chopper",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const rawNext = (await searchParams).next;
  const next = safeNextPath(Array.isArray(rawNext) ? rawNext[0] : rawNext);

  if ((await cookies()).has(SESSION_COOKIE) && (await getOperator())) redirect(next);

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm">
        <h1 className="text-center text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Telemetry Chopper
        </h1>
        <p className="mt-1 text-center text-sm text-zinc-500 dark:text-zinc-400">
          Sign in to the control plane
        </p>
        <div className="mt-8 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <LoginForm next={next} />
        </div>
      </div>
    </main>
  );
}
