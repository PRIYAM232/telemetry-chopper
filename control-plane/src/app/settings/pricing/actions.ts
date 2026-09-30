"use server";

// Server Action backing the /settings/pricing rate-card form.
//
// Same trust model as the dashboard's rule actions (see
// src/app/dashboard/actions.ts): no operator auth yet, so when it lands this
// action must verify the session before writing.

import { revalidatePath } from "next/cache";
import { ObservabilityVendor } from "@/generated/prisma/enums";
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
  for (const [key, label] of [
    ["tracesPricePerGb", "trace"],
    ["logsPricePerGb", "log"],
    ["metricsPricePerGb", "metric"],
  ] as const) {
    const raw = formString(formData, key).replace(/^\$/, "");
    if (!PRICE_RE.test(raw)) {
      return fail(
        `${label} price must be a USD amount per GB with at most 4 decimal places, e.g. 0.10`,
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
  });

  revalidatePath("/settings/pricing");
  revalidatePath("/dashboard");
  return { error: null, savedAt: Date.now() };
}
