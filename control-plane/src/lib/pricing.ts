// Vendor rate cards: a fleet's negotiated per-GB ingest prices, and the
// savings arithmetic that prices the bytes its rules dropped.
//
// The data plane measures dropped volume as the OTLP protobuf size of each
// removed span / log record / metric (see statsPayload in
// data-plane/processors/filterprocessor/engine.go). Vendors bill their own
// ingest encoding, so dollars here are an estimate — but one driven by real
// measured bytes and the operator's real contract, not a blended guess.

import { ObservabilityVendor } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";

// Vendors bill decimal gigabytes.
export const BYTES_PER_GB = 1_000_000_000;

// Price applied to every signal until the operator saves a rate card.
export const DEFAULT_PRICE_PER_GB_USD = 0.1;

export const VENDOR_LABELS: Record<ObservabilityVendor, string> = {
  [ObservabilityVendor.DATADOG]: "Datadog",
  [ObservabilityVendor.SPLUNK]: "Splunk",
  [ObservabilityVendor.NEW_RELIC]: "New Relic",
  [ObservabilityVendor.CUSTOM]: "Custom",
};

export type SignalPrices = {
  tracesPricePerGb: number;
  logsPricePerGb: number;
  metricsPricePerGb: number;
};

// A plain, serializable view of PricingConfig (Prisma Decimals can't cross
// into client components). vendor is null while the fleet runs on defaults.
export type RateCard = SignalPrices & {
  vendor: ObservabilityVendor | null;
  customVendorName: string | null;
};

export const DEFAULT_RATE_CARD: RateCard = {
  vendor: null,
  customVendorName: null,
  tracesPricePerGb: DEFAULT_PRICE_PER_GB_USD,
  logsPricePerGb: DEFAULT_PRICE_PER_GB_USD,
  metricsPricePerGb: DEFAULT_PRICE_PER_GB_USD,
};

export function rateCardLabel(card: RateCard): string {
  if (card.vendor === null) return "default rate";
  if (card.vendor === ObservabilityVendor.CUSTOM && card.customVendorName) {
    return card.customVendorName;
  }
  return VENDOR_LABELS[card.vendor];
}

export async function getRateCard(fleetId: string): Promise<RateCard> {
  const row = await prisma.pricingConfig.findUnique({ where: { fleetId } });
  if (!row) return DEFAULT_RATE_CARD;
  return {
    vendor: row.vendor,
    customVendorName: row.customVendorName,
    tracesPricePerGb: row.tracesPricePerGb.toNumber(),
    logsPricePerGb: row.logsPricePerGb.toNumber(),
    metricsPricePerGb: row.metricsPricePerGb.toNumber(),
  };
}

export async function saveRateCard(
  fleetId: string,
  card: RateCard & { vendor: ObservabilityVendor },
): Promise<void> {
  const data = {
    vendor: card.vendor,
    // The name only means something for CUSTOM; don't keep a stale one
    // around after switching to a named vendor.
    customVendorName:
      card.vendor === ObservabilityVendor.CUSTOM ? card.customVendorName : null,
    tracesPricePerGb: card.tracesPricePerGb,
    logsPricePerGb: card.logsPricePerGb,
    metricsPricePerGb: card.metricsPricePerGb,
  };
  await prisma.pricingConfig.upsert({
    where: { fleetId },
    create: { fleetId, ...data },
    update: data,
  });
}

export type DroppedBytes = { traces: number; logs: number; metrics: number };

export type Savings = {
  droppedBytes: number;
  tracesUSD: number;
  logsUSD: number;
  metricsUSD: number;
  totalUSD: number;
};

export function computeSavings(bytes: DroppedBytes, prices: SignalPrices): Savings {
  const tracesUSD = (bytes.traces / BYTES_PER_GB) * prices.tracesPricePerGb;
  const logsUSD = (bytes.logs / BYTES_PER_GB) * prices.logsPricePerGb;
  const metricsUSD = (bytes.metrics / BYTES_PER_GB) * prices.metricsPricePerGb;
  return {
    droppedBytes: bytes.traces + bytes.logs + bytes.metrics,
    tracesUSD,
    logsUSD,
    metricsUSD,
    totalUSD: tracesUSD + logsUSD + metricsUSD,
  };
}
