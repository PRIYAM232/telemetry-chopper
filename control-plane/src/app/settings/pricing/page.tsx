// /settings/pricing — the fleet's vendor rate card.
//
// The dashboard's savings banner multiplies the bytes each signal's rules
// dropped by the per-GB prices saved here (src/lib/pricing.ts).

import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { DEFAULT_PRICE_PER_GB_USD, VENDOR_LABELS, getRateCard } from "@/lib/pricing";
import { PricingForm } from "./pricing-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Telemetry Chopper — Pricing Configuration",
  description: "Set your observability vendor's negotiated per-GB ingest prices.",
};

export default async function PricingSettingsPage() {
  // Same fleet the dashboard shows: the control plane manages one fleet per
  // deployment today.
  const fleet = await prisma.collectorFleet.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/dashboard"
        className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        ← Dashboard
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        Pricing configuration
      </h1>

      {!fleet ? (
        <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
          No collector fleet found. Seed the development fleet first with{" "}
          <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs dark:bg-zinc-900">
            npx prisma db seed
          </code>
          .
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Savings for fleet{" "}
            <span className="font-medium text-zinc-900 dark:text-zinc-200">{fleet.name}</span>{" "}
            are priced as the GB each signal&apos;s rules dropped × your per-GB rate.
          </p>
          <PricingSection fleetId={fleet.id} />
        </>
      )}
    </main>
  );
}

async function PricingSection({ fleetId }: { fleetId: string }) {
  const card = await getRateCard(fleetId);
  return (
    <section className="mt-6 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
      {card.vendor === null && (
        <p className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-400">
          No rate card saved yet. The dashboard is using a default $
          {DEFAULT_PRICE_PER_GB_USD.toFixed(2)}/GB for every signal.
        </p>
      )}
      <PricingForm fleetId={fleetId} card={card} vendorLabels={VENDOR_LABELS} />
      <p className="mt-6 border-t border-zinc-100 pt-4 text-xs text-zinc-400 dark:border-zinc-900 dark:text-zinc-500">
        Dropped volume is the OTLP protobuf size of each record the collectors removed, in
        decimal GB (10⁹ bytes). Your vendor bills its own ingest encoding, so treat the
        dollar figure as a close estimate.
      </p>
    </section>
  );
}
