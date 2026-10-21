// /settings/operators — who can sign in to the console.

import type { Metadata } from "next";
import { TopBar } from "@/app/top-bar";
import { requireOperator } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { AddOperatorForm, RemoveOperatorButton } from "./operator-forms";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Operators — Telemetry Chopper",
};

const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export default async function OperatorsPage() {
  const operator = await requireOperator();
  const operators = await prisma.operator.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      email: true,
      name: true,
      mustChangePassword: true,
      lastSignInAt: true,
      createdAt: true,
    },
  });

  return (
    <>
      <TopBar operator={operator} current="/settings/operators" />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Operators
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          People who can sign in to this control plane. Every operator can change rules,
          pricing and this list, so only add people you trust with production telemetry.
        </p>

        <section className="mt-6 rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {operators.map((op) => (
              <li key={op.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {op.name ? `${op.name} · ` : ""}
                    {op.email}
                    {op.id === operator.id && (
                      <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-normal text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
                        you
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                    {op.mustChangePassword
                      ? "Hasn't chosen a password yet"
                      : op.lastSignInAt
                        ? `Last signed in ${dateFmt.format(op.lastSignInAt)}`
                        : "Never signed in"}
                    {" · "}added {dateFmt.format(op.createdAt)}
                  </p>
                </div>
                {op.id !== operator.id && (
                  <RemoveOperatorButton operatorId={op.id} email={op.email} />
                )}
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-6 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">Add an operator</h2>
          <div className="mt-4">
            <AddOperatorForm />
          </div>
        </section>
      </main>
    </>
  );
}
