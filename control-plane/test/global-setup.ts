// Runs once before any test file: creates the test database if it doesn't
// exist yet and applies every migration, so the tests see exactly the schema
// a deployment gets from `prisma migrate deploy`.

import { execFileSync } from "node:child_process";
import { Client } from "pg";
import { testDatabaseUrl } from "./database-url";

export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  const target = new URL(url);
  const name = target.pathname.slice(1);

  // CREATE DATABASE can't run inside the database it creates; connect to
  // the server's default one instead.
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (rowCount === 0) {
      await client.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
    }
  } finally {
    await client.end();
  }

  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    // Errors go to stderr; the per-migration listing on stdout is noise.
    stdio: ["ignore", "ignore", "inherit"],
  });
}
