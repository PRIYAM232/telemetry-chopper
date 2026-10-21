// Vitest runs the control plane's tests against a real PostgreSQL database,
// migrated to the current schema by test/global-setup.ts. Route handlers and
// src/lib are imported directly; nothing starts a Next.js server.
//
// The database is TEST_DATABASE_URL, defaulting to a chopper_test database
// on the docker-compose Postgres. Tests empty every table between cases, so
// the name must end in _test (enforced in test/database-url.ts).

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { testDatabaseUrl } from "./test/database-url";

export default defineConfig({
  resolve: {
    alias: {
      "@test": fileURLToPath(new URL("./test", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    setupFiles: ["test/setup.ts"],
    env: { DATABASE_URL: testDatabaseUrl() },
    // One database shared by every file, so files run one at a time.
    fileParallelism: false,
  },
});
