// Test database helpers: reset between tests and build the rows most tests
// need.

import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
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

export async function createFleet(name = "test-fleet") {
  return prisma.collectorFleet.create({
    data: { id: randomUUID(), name, apiKey: `chopper_test_sk_${randomBytes(16).toString("hex")}` },
  });
}
