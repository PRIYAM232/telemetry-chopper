"use server";

// Server Actions backing the /settings/pricing rate-card, volume
// commitment and cloud egress forms.
//
// Same trust model as the dashboard's rule actions (see
// src/app/dashboard/actions.ts): no operator auth yet, so when it lands this
// action must verify the session before writing.

import { revalidatePath } from "next/cache";
import { ObservabilityVendor } from "@/generated/prisma/enums";
import { saveEgressConfig } from "@/lib/egress";
import { saveCommitment } from "@/lib/overage";
import { saveRateCard } from "@/lib/pricing";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Matches the NUMERIC(10, 4) columns exactly, so what the operator typed is
// what gets stored — no silent rounding by Postgres.
const PRICE_RE = /^\d{1,6}(\.\d{1,4})?$/;

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

// savedAt changes on every successful save so the form can tell a fresh
// confirmation from the previous one.
export type SavePricingState = { error: string | null; savedAt: number | null };

function fail(error: string): SavePricingState {
  return { error, savedAt: null };
}

export async function savePricing(
  _prev: SavePricingState,
  formData: FormData,
): Promise<SavePricingState> {
  const fleetId = formString(formData, "fleetId");
  const vendor = formString(formData, "vendor");
  const customVendorName = formString(formData, "customVendorName");

  if (!UUID_RE.test(fleetId)) return fail("invalid fleet id");
  if (!(Object.values(ObservabilityVendor) as string[]).includes(vendor)) {
    return fail("choose an observability vendor");
  }
  const vendorValue = vendor as ObservabilityVendor;
  if (vendorValue === ObservabilityVendor.CUSTOM && !customVendorName) {
    return fail("vendor name is required for a custom vendor");
  }
  if (customVendorName.length > 64) {
    return fail("vendor name must be at most 64 characters");
  }

  const prices: Record<string, number> = {};
  for (const [key, label, unit, example] of [
    ["tracesPricePerGb", "trace ingest", "per GB", "0.10"],
    ["logsPricePerGb", "log ingest", "per GB", "0.10"],
    ["metricsPricePerGb", "metric ingest", "per GB", "0.10"],
    ["tracesIndexPricePerMillion", "indexed span", "per million events", "1.70"],
    ["logsIndexPricePerMillion", "indexed log event", "per million events", "1.70"],
  ] as const) {
    const raw = formString(formData, key).replace(/^\$/, "");
    if (!PRICE_RE.test(raw)) {
      return fail(
        `${label} price must be a USD amount ${unit} with at most 4 decimal places, e.g. ${example}`,
      );
    }
    prices[key] = Number(raw);
  }

  await saveRateCard(fleetId, {
    vendor: vendorValue,
    customVendorName: customVendorName || null,
    tracesPricePerGb: prices.tracesPricePerGb,
    logsPricePerGb: prices.logsPricePerGb,
    metricsPricePerGb: prices.metricsPricePerGb,
    tracesIndexPricePerMillion: prices.tracesIndexPricePerMillion,
    logsIndexPricePerMillion: prices.logsIndexPricePerMillion,
  });

  revalidatePath("/settings/pricing");
  revalidatePath("/dashboard");
  return { error: null, savedAt: Date.now() };
}

// Matches NUMERIC(14, 3) / NUMERIC(5, 2), like PRICE_RE for the rate card.
const COMMITTED_GB_RE = /^\d{1,11}(\.\d{1,3})?$/;
const MULTIPLIER_RE = /^\d{1,3}(\.\d{1,2})?$/;

export type SaveCommitmentState = SavePricingState;

export async function saveCommitmentAction(
  _prev: SaveCommitmentState,
  formData: FormData,
): Promise<SaveCommitmentState> {
  const fleetId = formString(formData, "fleetId");
  const committedRaw = formString(formData, "committedGbPerMonth").replace(/,/g, "");
  const multiplierRaw = formString(formData, "overageMultiplier").replace(/x$/i, "");
  const cycleDayRaw = formString(formData, "billingCycleDay");

  if (!UUID_RE.test(fleetId)) return fail("invalid fleet id");
  if (!COMMITTED_GB_RE.test(committedRaw) || Number(committedRaw) <= 0) {
    return fail("committed volume must be a positive number of GB per month, e.g. 5000");
  }
  if (!MULTIPLIER_RE.test(multiplierRaw)) {
    return fail("overage multiplier must be a number like 1.5 (up to 2 decimal places)");
  }
  const overageMultiplier = Number(multiplierRaw);
  // Below 1 would make overage cheaper than the committed rate — not a
  // penalty tier. Above 10 is almost certainly a typo.
  if (overageMultiplier < 1 || overageMultiplier > 10) {
    return fail("overage multiplier must be between 1 (no penalty) and 10");
  }
  const billingCycleDay = Number(cycleDayRaw);
  if (!Number.isInteger(billingCycleDay) || billingCycleDay < 1 || billingCycleDay > 28) {
    return fail("billing cycle day must be a whole number from 1 to 28");
  }

  await saveCommitment(fleetId, {
    committedGbPerMonth: Number(committedRaw),
    overageMultiplier,
    billingCycleDay,
  });

  revalidatePath("/settings/pricing");
  revalidatePath("/dashboard");
  return { error: null, savedAt: Date.now() };
}

// Matches NUMERIC(6, 2).
const RATIO_RE = /^\d{1,4}(\.\d{1,2})?$/;

export type SaveEgressState = SavePricingState;

export async function saveEgressAction(
  _prev: SaveEgressState,
  formData: FormData,
): Promise<SaveEgressState> {
  const fleetId = formString(formData, "fleetId");
  // An unchecked checkbox is simply absent from the form data.
  const enabled = formData.get("enabled") === "on";
  const priceRaw = formString(formData, "egressPricePerGb").replace(/^\$/, "");
  const ratioRaw = formString(formData, "compressionRatio").replace(/:1$/, "");

  if (!UUID_RE.test(fleetId)) return fail("invalid fleet id");
  if (!PRICE_RE.test(priceRaw)) {
    return fail("egress price must be a USD amount per GB with at most 4 decimal places, e.g. 0.09");
  }
  if (!RATIO_RE.test(ratioRaw)) {
    return fail("compression ratio must be a number like 4 (for 4:1), up to 2 decimal places");
  }
  const compressionRatio = Number(ratioRaw);
  // Below 1 would mean the wire carries MORE than the uncompressed payload.
  if (compressionRatio < 1 || compressionRatio > 100) {
    return fail("compression ratio must be between 1 (uncompressed) and 100");
  }

  await saveEgressConfig(fleetId, {
    enabled,
    pricePerGb: Number(priceRaw),
    compressionRatio,
  });

  revalidatePath("/settings/pricing");
  revalidatePath("/dashboard");
  return { error: null, savedAt: Date.now() };
}
