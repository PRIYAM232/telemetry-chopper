// Seed script — provisions one deterministic dev fleet plus three policy
// rules so the data plane can be tested immediately after `prisma db seed`.
//
// FIXED UUIDs and key, so they can be hardcoded in
// data-plane/config/otelcol-dev.yaml. These credentials are for LOCAL
// DEVELOPMENT ONLY.
//
// Create-only: if the dev fleet already exists the script changes nothing.
// Docker Compose and the Helm chart run it on every start or upgrade, and it
// used to write the dev key and sample rules back each time, undoing a key
// rotation, a paused rule or an edited one.
//
// Run via the Prisma CLI (configured in prisma.config.ts):  npx prisma db seed

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { fleetKeyHint, hashFleetKey } from "../src/lib/fleet-keys";

export const DEV_FLEET_ID = "f1ee7000-0000-4000-8000-000000000001";
export const DEV_FLEET_API_KEY =
  "chopper_dev_sk_2f7d1b9c4e8a4f60b3d5a9c1e6f80712";

const RULE_DROP_404 = "0a000000-0000-4000-8000-000000000001";
const RULE_DROP_HEALTHZ = "0a000000-0000-4000-8000-000000000002";
const RULE_SAMPLE_CHECKOUT = "0a000000-0000-4000-8000-000000000003";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

async function main() {
  const existing = await prisma.collectorFleet.findUnique({
    where: { id: DEV_FLEET_ID },
    select: { name: true },
  });
  if (existing) {
    console.log(`Dev fleet "${existing.name}" already exists; nothing to seed.`);
    return;
  }

  const fleet = await prisma.collectorFleet.create({
    data: {
      id: DEV_FLEET_ID,
      name: "local-dev-fleet",
      description:
        "Deterministic development fleet for local end-to-end testing of the chopper_filter sync loop.",
      apiKeyHash: hashFleetKey(DEV_FLEET_API_KEY),
      apiKeyHint: fleetKeyHint(DEV_FLEET_API_KEY),
    },
  });

  const rules = [
    {
      id: RULE_DROP_404,
      name: "drop-404-spans",
      isActive: true,
      actionType: "DROP",
      sampleRate: null,
      targetSignal: "TRACES",
      conditionField: "http.status_code",
      conditionOp: "EQUALS",
      conditionValue: "404",
    },
    {
      id: RULE_DROP_HEALTHZ,
      name: "drop-healthcheck-noise",
      isActive: true,
      actionType: "DROP",
      sampleRate: null,
      targetSignal: "TRACES",
      conditionField: "http.route",
      conditionOp: "CONTAINS",
      conditionValue: "/healthz",
    },
    {
      // Exercises forward compatibility: the Phase 2 data plane only executes
      // DROP, so it must fetch this rule, hold it in cache, and skip it
      // without erroring until SAMPLE lands in Phase 3.
      id: RULE_SAMPLE_CHECKOUT,
      name: "sample-checkout-service",
      isActive: true,
      actionType: "SAMPLE",
      sampleRate: 0.25,
      // Samples only the checkout-service spans, so the dashboard shows the
      // "matching spans only" scope next to the rule (issue #45).
      sampleScope: "SPAN",
      targetSignal: "TRACES",
      conditionField: "service.name",
      conditionOp: "EQUALS",
      conditionValue: "checkout-service",
    },
  ] as const;

  await prisma.policyRule.createMany({
    data: rules.map((rule) => ({ ...rule, fleetId: fleet.id })),
  });

  console.log(`Seeded fleet "${fleet.name}"`);
  console.log(`  fleet_id : ${fleet.id}`);
  console.log(`  api_key  : ${DEV_FLEET_API_KEY}`);
  console.log(`  rules    : ${rules.map((r) => r.name).join(", ")}`);
  console.log(
    `\nPoll it:\n  curl -s http://localhost:3000/api/v1/policies/${fleet.id} \\\n    -H "Authorization: Bearer ${DEV_FLEET_API_KEY}" | jq`,
  );
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
