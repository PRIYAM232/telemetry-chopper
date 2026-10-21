import { randomBytes, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword, timingDummyHash, verifyPassword } from "@/lib/password";

describe("hashPassword / verifyPassword", () => {
  it("produces a self-describing scrypt hash that verifies", async () => {
    const hash = await hashPassword("correct horse battery");
    const parts = hash.split("$");
    expect(parts.slice(0, 4)).toEqual(["scrypt", "32768", "8", "1"]);
    expect(Buffer.from(parts[4], "base64")).toHaveLength(16);
    expect(Buffer.from(parts[5], "base64")).toHaveLength(64);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse batterY", hash)).toBe(false);
  });

  it("salts every hash", async () => {
    const [a, b] = await Promise.all([hashPassword("same password!"), hashPassword("same password!")]);
    expect(a).not.toBe(b);
  });

  it("treats NFKC-equivalent spellings as the same password", async () => {
    // U+FB01 (the "fi" ligature) normalizes to "fi".
    const hash = await hashPassword("ﬁve passwords");
    expect(await verifyPassword("five passwords", hash)).toBe(true);
  });

  it("verifies with the parameters stored in the hash, so the cost can change later", async () => {
    const salt = randomBytes(16);
    const key = scryptSync("older password", salt, 32, { N: 1024, r: 8, p: 1 });
    const legacy = ["scrypt", 1024, 8, 1, salt.toString("base64"), key.toString("base64")].join("$");
    expect(await verifyPassword("older password", legacy)).toBe(true);
    expect(await verifyPassword("wrong password", legacy)).toBe(false);
  });

  it.each([
    ["an empty string", ""],
    ["another algorithm", "bcrypt$10$abc"],
    ["too few fields", "scrypt$32768$8$1$c2FsdA=="],
    ["non-numeric cost", "scrypt$abc$8$1$c2FsdA==$a2V5"],
    ["zero cost", "scrypt$0$8$1$c2FsdA==$a2V5"],
    ["an empty key", "scrypt$1024$8$1$c2FsdA==$"],
  ])("returns false for %s instead of throwing", async (_, stored) => {
    expect(await verifyPassword("anything at all", stored)).toBe(false);
  });
});

describe("timingDummyHash", () => {
  it("is one memoized, well-formed hash", async () => {
    const [a, b] = [await timingDummyHash(), await timingDummyHash()];
    expect(a).toBe(b);
    expect(a.startsWith("scrypt$32768$8$1$")).toBe(true);
  });
});
