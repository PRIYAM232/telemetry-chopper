// /audit — the audit trail (issue #10): every rule, pricing and operator
// change, and every sign-in, newest first.

import type { Metadata } from "next";
import Link from "next/link";
import { TopBar } from "@/app/top-bar";
import { AUDIT_ACTION_LABELS } from "@/lib/audit";
import { requireOperator } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Audit log — Telemetry Chopper",
};

const PAGE_SIZE = 50;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const timeFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
});

// One line per detail field, skipping the empty ones: rule snapshots carry
// a column for every action type, most of them null.
function detailLines(details: unknown): string[] {
  if (!details || typeof details !== "object" || Array.isArray(details)) return [];
  return Object.entries(details as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ after?: string | string[] }>;
}) {
  const operator = await requireOperator();
  const rawAfter = (await searchParams).after;
  const after = typeof rawAfter === "string" && UUID_RE.test(rawAfter) ? rawAfter : null;

  // Keyset pagination on (createdAt, id): "after" is the last event of the
  // previous page.
  const rows = await prisma.auditEvent.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PAGE_SIZE + 1,
    ...(after ? { cursor: { id: after }, skip: 1 } : {}),
  });
  const events = rows.slice(0, PAGE_SIZE);
  const olderCursor = rows.length > PAGE_SIZE ? events[events.length - 1].id : null;

  return (
    <>
      <TopBar operator={operator} current="/audit" />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Audit log
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Every change to rules, pricing and operators, and every sign-in, newest first.
        </p>

        <section className="mt-6 rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          {events.length === 0 ? (
            <p className="px-6 py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
              {after ? "No older events." : "Nothing recorded yet."}
            </p>
          ) : (
            <ol className="divide-y divide-zinc-100 text-sm dark:divide-zinc-900">
              {events.map((event) => {
                const lines = detailLines(event.details);
                const failed = event.action === "OPERATOR_SIGN_IN_FAILED";
                return (
                  // Stacked on phones; three columns (when, who, what) from sm up.
                  <li
                    key={event.id}
                    className="flex flex-col gap-1 px-4 py-3 sm:grid sm:grid-cols-[14rem_12rem_1fr] sm:gap-4"
                  >
                    <time
                      dateTime={event.createdAt.toISOString()}
                      className="order-3 text-xs tabular-nums text-zinc-500 sm:order-none sm:text-sm dark:text-zinc-400"
                    >
                      {timeFmt.format(event.createdAt)}
                    </time>
                    <span className="order-2 truncate text-zinc-700 sm:order-none dark:text-zinc-300">
                      {event.actor}
                    </span>
                    <div className="order-1 min-w-0 sm:order-none">
                      <span
                        className={
                          failed
                            ? "font-medium text-rose-600 dark:text-rose-400"
                            : "font-medium text-zinc-900 dark:text-zinc-100"
                        }
                      >
                        {AUDIT_ACTION_LABELS[event.action]}
                      </span>
                      {event.targetName && (
                        <span className="text-zinc-600 dark:text-zinc-400"> {event.targetName}</span>
                      )}
                      {lines.length > 0 && (
                        <div className="mt-1 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                          {lines.map((line) => (
                            <div key={line} className="break-all">
                              {line}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <div className="mt-4 flex gap-4 text-sm">
          {after && (
            <Link href="/audit" className="text-zinc-600 underline underline-offset-2 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
              Newest
            </Link>
          )}
          {olderCursor && (
            <Link
              href={`/audit?after=${olderCursor}`}
              className="text-zinc-600 underline underline-offset-2 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              Older events →
            </Link>
          )}
        </div>
      </main>
    </>
  );
}
