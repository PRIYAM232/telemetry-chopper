// Cloud egress: the cloud provider's outbound data-transfer fee on telemetry
// leaving its network for the observability vendor.
//
// Every byte the ruleset drops in the collector is a byte that never leaves
// the network, so it saves egress as well as the vendor's ingest. Records
// the ruleset only marks (EXCLUDE_INDEX) or routes still leave, so they
// save none.
//
// The data plane measures uncompressed OTLP protobuf, but providers bill
// bytes on the wire and OTLP exporters compress (gzip by default), so the
// dropped volume is divided by the operator's compression ratio.

import { prisma } from "@/lib/prisma";
import { BYTES_PER_GB } from "@/lib/pricing";

// AWS's first internet-egress tier; the operator's own rate replaces it.
export const DEFAULT_EGRESS_PRICE_PER_GB_USD = 0.09;

export type EgressConfig = {
  enabled: boolean;
  pricePerGb: number;
  compressionRatio: number;
};

export const DEFAULT_EGRESS_CONFIG: EgressConfig = {
  enabled: false,
  pricePerGb: DEFAULT_EGRESS_PRICE_PER_GB_USD,
  compressionRatio: 1,
};

export async function getEgressConfig(fleetId: string): Promise<EgressConfig> {
  const row = await prisma.egressConfig.findUnique({ where: { fleetId } });
  if (!row) return DEFAULT_EGRESS_CONFIG;
  return {
    enabled: row.enabled,
    pricePerGb: row.pricePerGb.toNumber(),
    compressionRatio: row.compressionRatio.toNumber(),
  };
}

export async function saveEgressConfig(fleetId: string, c: EgressConfig): Promise<void> {
  await prisma.egressConfig.upsert({
    where: { fleetId },
    create: { fleetId, ...c },
    update: c,
  });
}

export type EgressSavings = {
  enabled: boolean;
  // Dropped volume as the provider would have metered it (after compression).
  wireBytes: number;
  usd: number;
};

export function computeEgressSavings(droppedBytes: number, c: EgressConfig): EgressSavings {
  const wireBytes = droppedBytes / c.compressionRatio;
  return {
    enabled: c.enabled,
    wireBytes,
    usd: c.enabled ? (wireBytes / BYTES_PER_GB) * c.pricePerGb : 0,
  };
}
