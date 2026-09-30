// Vendor rate cards: a fleet's negotiated per-GB ingest prices and
// per-million indexing prices, and the savings arithmetic that prices what
// its rules dropped or kept out of the index.
//
// Split-metric pricing (e.g. Datadog: ingest per GB + indexed events per
// million) is modeled by what actually happens to each record:
//   - dropped in the collector (DROP, unsampled SAMPLE, THROTTLE excess):
//     never reaches the vendor, so it saves ingest (its bytes x $/GB) AND
//     indexing (1 event x $/million);
//   - forwarded with chopper.index = false (EXCLUDE_INDEX): still ingested,
//     so it saves indexing only.
// Indexing savings assume the vendor would otherwise have indexed every
// event it ingested.
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

// USD per million indexed events. Metrics aren't indexed events.
export type IndexPrices = {
  tracesIndexPricePerMillion: number;
  logsIndexPricePerMillion: number;
};

// A plain, serializable view of PricingConfig (Prisma Decimals can't cross
// into client components). vendor is null while the fleet runs on defaults.
export type RateCard = SignalPrices & IndexPrices & {
  vendor: ObservabilityVendor | null;
  customVendorName: string | null;
};

export const DEFAULT_RATE_CARD: RateCard = {
  vendor: null,
  customVendorName: null,
  tracesPricePerGb: DEFAULT_PRICE_PER_GB_USD,
  logsPricePerGb: DEFAULT_PRICE_PER_GB_USD,
  metricsPricePerGb: DEFAULT_PRICE_PER_GB_USD,
  // Not every vendor bills indexing separately; don't assume one does.
  tracesIndexPricePerMillion: 0,
  logsIndexPricePerMillion: 0,
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
    tracesIndexPricePerMillion: row.tracesIndexPricePerMillion.toNumber(),
    logsIndexPricePerMillion: row.logsIndexPricePerMillion.toNumber(),
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
    tracesIndexPricePerMillion: card.tracesIndexPricePerMillion,
    logsIndexPricePerMillion: card.logsIndexPricePerMillion,
  };
  await prisma.pricingConfig.upsert({
    where: { fleetId },
    create: { fleetId, ...data },
    update: data,
  });
}

export type DroppedBytes = { traces: number; logs: number; metrics: number };
// Event counts for the indexed signals.
export type IndexedEvents = { traces: number; logs: number };

export type SavingsInput = {
  droppedBytes: DroppedBytes;
  // Records removed in the collector: never ingested, never indexed.
  droppedEvents: IndexedEvents;
  // Records forwarded but opted out of indexing by EXCLUDE_INDEX.
  unindexedEvents: IndexedEvents;
};

export type Savings = {
  droppedBytes: number;
  droppedBytesBySignal: DroppedBytes;
  ingest: { traces: number; logs: number; metrics: number; total: number };
  indexing: {
    traces: number;
    logs: number;
    total: number;
    // Events whose indexing cost was avoided, split by how.
    droppedEvents: number;
    unindexedEvents: number;
  };
  totalUSD: number;
};

const EVENTS_PER_MILLION = 1_000_000;

export function computeSavings(input: SavingsInput, card: SignalPrices & IndexPrices): Savings {
  const { droppedBytes: b, droppedEvents: d, unindexedEvents: u } = input;
  const ingest = {
    traces: (b.traces / BYTES_PER_GB) * card.tracesPricePerGb,
    logs: (b.logs / BYTES_PER_GB) * card.logsPricePerGb,
    metrics: (b.metrics / BYTES_PER_GB) * card.metricsPricePerGb,
    total: 0,
  };
  ingest.total = ingest.traces + ingest.logs + ingest.metrics;
  const indexing = {
    traces: ((d.traces + u.traces) / EVENTS_PER_MILLION) * card.tracesIndexPricePerMillion,
    logs: ((d.logs + u.logs) / EVENTS_PER_MILLION) * card.logsIndexPricePerMillion,
    total: 0,
    droppedEvents: d.traces + d.logs,
    unindexedEvents: u.traces + u.logs,
  };
  indexing.total = indexing.traces + indexing.logs;
  return {
    droppedBytes: b.traces + b.logs + b.metrics,
    droppedBytesBySignal: b,
    ingest,
    indexing,
    totalUSD: ingest.total + indexing.total,
  };
}
