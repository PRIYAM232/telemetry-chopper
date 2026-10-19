// Per-file setup: every test starts from empty tables, and each file closes
// its connection pool when it finishes.

import { afterAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDatabase } from "./db";

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});
