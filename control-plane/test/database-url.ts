// The database the tests own. Every table in it is emptied before each test,
// so refuse anything that doesn't look like a throwaway test database: a
// TEST_DATABASE_URL pasted from a real deployment's .env must not wipe it.

const DEFAULT_URL = "postgresql://chopper:chopper@localhost:5432/chopper_test";

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL || DEFAULT_URL;
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) {
    throw new Error(
      `TEST_DATABASE_URL must name a database ending in _test (got "${name}"): ` +
        "the tests delete every row in it.",
    );
  }
  return url;
}
