// Test database helpers: reset between tests and build the rows most tests
// need.

import type { Prisma } from "@/generated/prisma/client";
import { createFleet as createFleetWithKey } from "@/lib/fleets";
import { prisma } from "@/lib/prisma";

/** Empties every table the migrations created, keeping the schema. */
export async function resetDatabase(): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename.replaceAll('"', '""')}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} CASCADE`);
}

/** A DROP rule on traces; override any field. */
export async function createRule(fleetId: string, data: Partial<Prisma.PolicyRuleUncheckedCreateInput> = {}) {
  return prisma.policyRule.create({
    data: {
      fleetId,
      name: "drop healthz",
      actionType: "DROP",
      targetSignal: "TRACES",
      conditionField: "http.route",
      conditionOp: "EQUALS",
      conditionValue: "/healthz",
      ...data,
    },
  });
}

/** A fleet with a fresh key; `apiKey` is the plaintext key collectors send. */
export async function createFleet(name = "test-fleet") {
  const { fleet, key } = await createFleetWithKey({ name, description: null });
  return { ...fleet, apiKey: key };
}
