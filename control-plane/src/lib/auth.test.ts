import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapFirstOperator,
  createSession,
  destroyOtherSessions,
  destroySession,
  getOperator,
  normalizeEmail,
  requireOperator,
  safeNextPath,
} from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/auth-cookie";
import { hashPassword, verifyPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";

// next/headers only works inside a Next.js request; stand in a cookie jar
// and request headers the tests control.
const request = vi.hoisted(() => ({
  cookies: new Map<string, { value: string; options?: Record<string, unknown> }>(),
  headers: new Headers(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const c = request.cookies.get(name);
      return c && { name, value: c.value };
    },
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      request.cookies.set(name, { value, options });
    },
    delete: (name: string) => {
      request.cookies.delete(name);
    },
  }),
  headers: async () => request.headers,
}));

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// redirect() throws; its digest carries the target path.
async function redirectTarget(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => {
      throw new Error("expected a redirect");
    },
    (e: { digest?: string }) => e,
  );
  return String(err.digest).split(";")[2];
}

async function createOperator(data: { email?: string; mustChangePassword?: boolean } = {}) {
  return prisma.operator.create({
    data: {
      email: data.email ?? "ops@example.com",
      passwordHash: "scrypt$unused",
      mustChangePassword: data.mustChangePassword ?? false,
    },
  });
}

/** Signs in as a fresh browser: cookies cleared, then a new session. */
async function signIn(operatorId: string): Promise<string> {
  request.cookies.clear();
  await createSession(operatorId);
  return request.cookies.get(SESSION_COOKIE)!.value;
}

beforeEach(() => {
  request.cookies.clear();
  request.headers = new Headers();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createSession", () => {
  it("stores only the token's SHA-256 and sets an httpOnly cookie for 7 days", async () => {
    const operator = await createOperator();
    const before = Date.now();
    const token = await signIn(operator.id);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const session = await prisma.operatorSession.findUniqueOrThrow({ where: { id: sha256(token) } });
    expect(session.operatorId).toBe(operator.id);
    expect(await prisma.operatorSession.count({ where: { id: token } })).toBe(0);

    const { options } = request.cookies.get(SESSION_COOKIE)!;
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    const week = 7 * 24 * 60 * 60 * 1000;
    expect((options!.expires as Date).getTime()).toBeGreaterThanOrEqual(before + week);
    expect(session.expiresAt.getTime()).toBe((options!.expires as Date).getTime());
  });

  it("drops expired sessions on sign-in", async () => {
    const operator = await createOperator();
    await prisma.operatorSession.create({
      data: { id: "expired", operatorId: operator.id, expiresAt: new Date(Date.now() - 1000) },
    });
    await signIn(operator.id);
    expect(await prisma.operatorSession.count({ where: { id: "expired" } })).toBe(0);
  });

  it.each([
    ["plain HTTP", {}, undefined, false],
    ["X-Forwarded-Proto https", { "x-forwarded-proto": "https" }, undefined, true],
    ["the first X-Forwarded-Proto hop", { "x-forwarded-proto": "http, https" }, undefined, false],
    ["an https Origin", { origin: "https://chopper.example" }, undefined, true],
    ["CHOPPER_SECURE_COOKIES=true over HTTP", {}, "true", true],
    ["CHOPPER_SECURE_COOKIES=false over HTTPS", { "x-forwarded-proto": "https" }, "false", false],
  ])("marks the cookie Secure correctly for %s", async (_, headers, override, secure) => {
    request.headers = new Headers(headers);
    if (override) vi.stubEnv("CHOPPER_SECURE_COOKIES", override);
    const operator = await createOperator();
    await signIn(operator.id);
    expect(request.cookies.get(SESSION_COOKIE)!.options!.secure).toBe(secure);
  });
});

describe("getOperator", () => {
  it("returns the operator behind a valid session cookie", async () => {
    const operator = await createOperator({ email: "a@example.com" });
    await signIn(operator.id);
    expect(await getOperator()).toEqual({
      id: operator.id,
      email: "a@example.com",
      name: null,
      mustChangePassword: false,
    });
  });

  it.each([
    ["no cookie", undefined],
    ["a malformed token", "not-a-token"],
    ["an unknown token", "A".repeat(43)],
  ])("returns null for %s", async (_, token) => {
    if (token) request.cookies.set(SESSION_COOKIE, { value: token });
    expect(await getOperator()).toBeNull();
  });

  it("returns null once the session has expired", async () => {
    const operator = await createOperator();
    const token = await signIn(operator.id);
    await prisma.operatorSession.update({
      where: { id: sha256(token) },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    expect(await getOperator()).toBeNull();
  });
});

describe("requireOperator", () => {
  it("returns the signed-in operator", async () => {
    const operator = await createOperator();
    await signIn(operator.id);
    expect((await requireOperator()).id).toBe(operator.id);
  });

  it("redirects to /login without a session", async () => {
    expect(await redirectTarget(requireOperator())).toBe("/login");
  });

  it("sends an operator who must change their password to /account/password, except from that page", async () => {
    const operator = await createOperator({ mustChangePassword: true });
    await signIn(operator.id);
    expect(await redirectTarget(requireOperator())).toBe("/account/password");
    expect((await requireOperator({ allowPendingPasswordChange: true })).id).toBe(operator.id);
  });
});

describe("destroySession / destroyOtherSessions", () => {
  it("signing out ends this browser's session and clears its cookie", async () => {
    const operator = await createOperator();
    const token = await signIn(operator.id);
    await destroySession();
    expect(request.cookies.has(SESSION_COOKIE)).toBe(false);
    expect(await prisma.operatorSession.count({ where: { id: sha256(token) } })).toBe(0);
  });

  it("ends every other session of the operator, keeping this one and other operators'", async () => {
    const operator = await createOperator();
    const someoneElse = await createOperator({ email: "other@example.com" });
    await signIn(operator.id);
    await signIn(someoneElse.id);
    await signIn(operator.id);
    const current = await signIn(operator.id);

    await destroyOtherSessions(operator.id);

    const remaining = await prisma.operatorSession.findMany({ select: { id: true, operatorId: true } });
    expect(remaining).toHaveLength(2);
    expect(remaining).toContainEqual({ id: sha256(current), operatorId: operator.id });
    expect(remaining.find((s) => s.operatorId === someoneElse.id)).toBeDefined();
  });
});

describe("bootstrapFirstOperator", () => {
  it("does nothing without CHOPPER_ADMIN_EMAIL and CHOPPER_ADMIN_PASSWORD", async () => {
    vi.stubEnv("CHOPPER_ADMIN_EMAIL", "");
    vi.stubEnv("CHOPPER_ADMIN_PASSWORD", "");
    expect(await bootstrapFirstOperator()).toEqual({ state: "unconfigured" });
  });

  it.each([
    ["an email without @", "admin", "correct horse battery", "CHOPPER_ADMIN_EMAIL is not an email address"],
    ["a short password", "admin@example.com", "short", "CHOPPER_ADMIN_PASSWORD: password must be at least 12 characters"],
  ])("refuses %s", async (_, email, password, problem) => {
    vi.stubEnv("CHOPPER_ADMIN_EMAIL", email);
    vi.stubEnv("CHOPPER_ADMIN_PASSWORD", password);
    expect(await bootstrapFirstOperator()).toEqual({ state: "invalid", problem });
    expect(await prisma.operator.count()).toBe(0);
  });

  it("creates the first operator, lowercased and required to change the password", async () => {
    vi.stubEnv("CHOPPER_ADMIN_EMAIL", "  Admin@Example.COM ");
    vi.stubEnv("CHOPPER_ADMIN_PASSWORD", "correct horse battery");

    const result = await bootstrapFirstOperator();

    expect(result.state).toBe("created");
    const operator = await prisma.operator.findUniqueOrThrow({ where: { email: "admin@example.com" } });
    expect(operator.mustChangePassword).toBe(true);
    expect(await verifyPassword("correct horse battery", operator.passwordHash)).toBe(true);
  });

  it("ignores the variables once any operator exists", async () => {
    await prisma.operator.create({
      data: { email: "someone@example.com", passwordHash: await hashPassword("a different password") },
    });
    vi.stubEnv("CHOPPER_ADMIN_EMAIL", "admin@example.com");
    vi.stubEnv("CHOPPER_ADMIN_PASSWORD", "correct horse battery");
    expect(await bootstrapFirstOperator()).toEqual({ state: "exists" });
    expect(await prisma.operator.count()).toBe(1);
  });
});

describe("safeNextPath", () => {
  it.each([
    ["/rules?tab=logs", "/rules?tab=logs"],
    ["/dashboard", "/dashboard"],
    [null, "/dashboard"],
    ["", "/dashboard"],
    ["https://evil.example", "/dashboard"],
    ["//evil.example", "/dashboard"],
    ["/\\evil.example", "/dashboard"],
    ["/login", "/dashboard"],
    ["/login?next=/x", "/dashboard"],
  ])("maps %j to %j", (next, expected) => {
    expect(safeNextPath(next)).toBe(expected);
  });
});

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Ops@Example.COM\n")).toBe("ops@example.com");
  });
});
