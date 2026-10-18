// Operator password hashing (issue #10).
//
// scrypt from node:crypto, so there is no native dependency to build into
// the Docker image. Hashes are self-describing — "scrypt$N$r$p$salt$hash",
// salt and hash base64 — so the cost can be raised later without breaking
// existing hashes: verifyPassword reads the parameters from the hash.

import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

// N = 2^15 costs ~50 ms on a laptop core: slow enough to make offline
// guessing expensive, fast enough for a sign-in form. 128·N·r bytes of
// memory (32 MiB) is above Node's 32 MiB default maxmem, hence the explicit
// limit below.
const COST = 1 << 15;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

export { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, passwordProblem } from "@/lib/password-policy";

function derive(password: string, salt: Buffer, options: ScryptOptions, keyLength: number) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      keyLength,
      { ...options, maxmem: 256 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(
    password,
    salt,
    { N: COST, r: BLOCK_SIZE, p: PARALLELISM },
    KEY_LENGTH,
  );
  return [
    "scrypt",
    COST,
    BLOCK_SIZE,
    PARALLELISM,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return false;
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (expected.length === 0) return false;

  const actual = await derive(password, salt, { N, r, p }, expected.length);
  return timingSafeEqual(actual, expected);
}

// Verified against when the email is unknown, so a sign-in for a
// nonexistent operator takes as long as one with a wrong password and
// response time doesn't reveal which emails have accounts.
let dummyHash: Promise<string> | null = null;
export function timingDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString("base64"));
  return dummyHash;
}
