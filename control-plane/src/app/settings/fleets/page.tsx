// /settings/fleets — create collector fleets and rotate their keys.

import type { Metadata } from "next";
import { TopBar } from "@/app/top-bar";
import { requireOperator } from "@/lib/auth";
import { isActive, PRUNE_AFTER_MS } from "@/lib/collectors";
import { prisma } from "@/lib/prisma";
import { CreateFleetForm, RevokePreviousKeyButton, RotateKeyControl } from "./fleet-forms";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Fleets — Telemetry Chopper",
};

const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export default async function FleetsPage() {
  const operator = await requireOperator();
  // force-dynamic: one request per render, so request-time "now" is stable.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const fleets = await prisma.collectorFleet.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      description: true,
      apiKeyHint: true,
      apiKeyCreatedAt: true,
      previousApiKeyHint: true,
      previousApiKeyExpiresAt: true,
      createdAt: true,
      collectors: {
        where: { lastSeenAt: { gte: new Date(nowMs - PRUNE_AFTER_MS) } },
        select: { intervalSeconds: true, lastSeenAt: true, usesPreviousKey: true },
      },
    },
  });

  return (
    <>
      <TopBar operator={operator} current="/settings/fleets" />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Fleets</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          A fleet is a group of collectors that share one set of rules and one key. Collectors send the
          key with every policy poll and heartbeat.
        </p>

        {fleets.length > 0 && (
          <ul className="mt-6 flex flex-col gap-4">
            {fleets.map((fleet) => {
              const active = fleet.collectors.filter((c) => isActive(c, nowMs));
              const onPrevious = active.filter((c) => c.usesPreviousKey).length;
              const previousValid =
                fleet.previousApiKeyHint !== null &&
                fleet.previousApiKeyExpiresAt !== null &&
                fleet.previousApiKeyExpiresAt.getTime() > nowMs;
              return (
                <li
                  key={fleet.id}
                  className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950"
                >
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-50">
                      {fleet.name}
                    </h2>
                    {fleet.description && (
                      <p className="mt-0.5 text-sm text-zinc-600 dark:text-zinc-400">{fleet.description}</p>
                    )}
                    <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                      <dt className="text-zinc-500 dark:text-zinc-400">Fleet ID</dt>
                      <dd>
                        <code className="break-all font-mono text-xs text-zinc-900 dark:text-zinc-200">
                          {fleet.id}
                        </code>
                      </dd>
                      <dt className="text-zinc-500 dark:text-zinc-400">Key</dt>
                      <dd className="text-zinc-900 dark:text-zinc-200">
                        <code className="font-mono text-xs">…{fleet.apiKeyHint}</code>
                        <span className="text-zinc-500 dark:text-zinc-400">
                          {" "}
                          · since {dateFmt.format(fleet.apiKeyCreatedAt)}
                        </span>
                      </dd>
                      <dt className="text-zinc-500 dark:text-zinc-400">Collectors</dt>
                      <dd className="text-zinc-900 dark:text-zinc-200">{active.length} online</dd>
                    </dl>
                  </div>

                  {previousValid && (
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-900 dark:bg-amber-950">
                      <p className="text-amber-900 dark:text-amber-200">
                        Previous key <code className="font-mono text-xs">…{fleet.previousApiKeyHint}</code> works
                        until {dateFmt.format(fleet.previousApiKeyExpiresAt!)}.{" "}
                        {onPrevious === 0
                          ? "No online collector uses it."
                          : `${onPrevious} of ${active.length} online collectors still use it.`}
                      </p>
                      <RevokePreviousKeyButton fleetId={fleet.id} hint={fleet.previousApiKeyHint!} />
                    </div>
                  )}

                  <RotateKeyControl fleetId={fleet.id} fleetName={fleet.name} />
                </li>
              );
            })}
          </ul>
        )}

        <section className="mt-6 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">Create a fleet</h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Use a separate fleet for each group of collectors that should run different rules, such as
            each environment or region.
          </p>
          <div className="mt-4">
            <CreateFleetForm />
          </div>
        </section>
      </main>
    </>
  );
}
