// Operator sessions and the dashboard's data access layer (issue #10).
//
// Every page and Server Action outside /login calls requireOperator() before
// it reads or writes anything. src/proxy.ts only redirects requests that
// carry no session cookie at all; it never decides who may do what, because
// Server Actions are reachable by direct POST and pages can be prefetched.
//
// Sessions are database rows: the cookie holds a random 256-bit token and
// the OperatorSession table its SHA-256, so signing out (or removing an
// operator) ends the session everywhere, immediately.

import { createHash, randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { SESSION_COOKIE } from "@/lib/auth-cookie";
import { prisma } from "@/lib/prisma";
import { hashPassword, passwordProblem } from "@/lib/password";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export type CurrentOperator = {
  id: string;
  email: string;
  name: string | null;
  mustChangePassword: boolean;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Secure cookies are dropped by browsers on plain-HTTP origins other than
// localhost, which would make sign-in loop forever on an http://10.x.x.x:3000
// deployment. So mark the cookie Secure when the request arrived over HTTPS
// (directly or via a TLS-terminating proxy), unless the operator overrides
// it with CHOPPER_SECURE_COOKIES=true|false.
async function requestIsHttps(): Promise<boolean> {
  const override = process.env.CHOPPER_SECURE_COOKIES?.trim().toLowerCase();
  if (override === "true") return true;
  if (override === "false") return false;
  const h = await headers();
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (proto) return proto === "https";
  return h.get("origin")?.startsWith("https://") ?? false;
}

/**
 * The signed-in operator, or null. Memoized per request, so a page and the
 * components it renders share one session lookup.
 */
export const getOperator = cache(async (): Promise<CurrentOperator | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !TOKEN_RE.test(token)) return null;

  const session = await prisma.operatorSession.findUnique({
    where: { id: hashToken(token) },
    select: {
      expiresAt: true,
      operator: { select: { id: true, email: true, name: true, mustChangePassword: true } },
    },
  });
  if (!session || session.expiresAt.getTime() <= Date.now()) return null;
  return session.operator;
});

/**
 * The signed-in operator; otherwise redirects to /login. An operator who
 * still has a password someone else chose is sent to /account/password
 * instead, unless the caller is that page.
 */
export async function requireOperator(
  options: { allowPendingPasswordChange?: boolean } = {},
): Promise<CurrentOperator> {
  const operator = await getOperator();
  if (!operator) redirect("/login");
  if (operator.mustChangePassword && !options.allowPendingPasswordChange) {
    redirect("/account/password");
  }
  return operator;
}

/** Starts a session for `operatorId` and sets its cookie. */
export async function createSession(operatorId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  // Housekeeping: expired sessions are useless, drop them on every sign-in.
  await prisma.operatorSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  await prisma.operatorSession.create({
    data: { id: hashToken(token), operatorId, expiresAt },
  });

  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: await requestIsHttps(),
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

/** Ends the current browser's session, if any, and clears its cookie. */
export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token && TOKEN_RE.test(token)) {
    await prisma.operatorSession.deleteMany({ where: { id: hashToken(token) } });
  }
  store.delete(SESSION_COOKIE);
}

/** Ends every session of `operatorId` except the current browser's. */
export async function destroyOtherSessions(operatorId: string): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const keep = token && TOKEN_RE.test(token) ? hashToken(token) : "";
  await prisma.operatorSession.deleteMany({ where: { operatorId, id: { not: keep } } });
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

// Deliberately loose: one @, no spaces. Operators are identified by email
// but nothing is ever sent to it.
export const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

export type BootstrapResult =
  | { state: "created"; operatorId: string }
  | { state: "exists" }
  | { state: "unconfigured" }
  | { state: "invalid"; problem: string };

/**
 * Creates the first operator from CHOPPER_ADMIN_EMAIL / CHOPPER_ADMIN_PASSWORD
 * when the Operator table is empty. Once any operator exists the variables
 * are ignored, so they can stay in a compose file or Helm secret without
 * resurrecting a removed account or resetting a changed password.
 *
 * The bootstrapped operator must choose a new password on first sign-in:
 * the one in the environment is shared with whoever can read the deploy
 * config.
 */
export async function bootstrapFirstOperator(): Promise<BootstrapResult> {
  if ((await prisma.operator.count()) > 0) return { state: "exists" };

  const email = normalizeEmail(process.env.CHOPPER_ADMIN_EMAIL ?? "");
  const password = process.env.CHOPPER_ADMIN_PASSWORD ?? "";
  if (!email || !password) return { state: "unconfigured" };
  if (!EMAIL_RE.test(email)) {
    return { state: "invalid", problem: "CHOPPER_ADMIN_EMAIL is not an email address" };
  }
  const problem = passwordProblem(password);
  if (problem) return { state: "invalid", problem: `CHOPPER_ADMIN_PASSWORD: ${problem}` };

  try {
    const operator = await prisma.operator.create({
      data: { email, passwordHash: await hashPassword(password), mustChangePassword: true },
      select: { id: true },
    });
    return { state: "created", operatorId: operator.id };
  } catch (err) {
    // Two first sign-ins racing: the other request created it.
    if ((err as { code?: string }).code === "P2002") return { state: "exists" };
    throw err;
  }
}

/**
 * `next` if it is a path on this site, else /dashboard. Keeps ?next= on the
 * sign-in page from being an open redirect: "//evil.example" and
 * "/\evil.example" are protocol-relative URLs to browsers.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return "/dashboard";
  }
  if (next === "/login" || next.startsWith("/login?")) return "/dashboard";
  return next;
}
