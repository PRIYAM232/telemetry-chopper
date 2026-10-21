"use server";

// Sign-in and sign-out (issue #10). signIn is the only Server Action that
// runs without a session; everything else calls requireOperator() first.

import { redirect } from "next/navigation";
import { AuditAction, recordAudit } from "@/lib/audit";
import {
  bootstrapFirstOperator,
  createSession,
  destroySession,
  getOperator,
  normalizeEmail,
  safeNextPath,
} from "@/lib/auth";
import {
  clearSignInFailures,
  recordSignInFailure,
  signInRetryAfterMs,
} from "@/lib/login-throttle";
import { MAX_PASSWORD_LENGTH, timingDummyHash, verifyPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";

export type SignInState = { error: string | null };

// One message for unknown email and wrong password, so the form can't be
// used to find out which emails have accounts.
const BAD_CREDENTIALS = "Incorrect email or password.";

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export async function signIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const email = normalizeEmail(formString(formData, "email"));
  const password = formString(formData, "password");
  const next = safeNextPath(formString(formData, "next"));

  if (!email || !password) return { error: "Enter your email and password." };
  if (email.length > 320 || password.length > MAX_PASSWORD_LENGTH) {
    return { error: BAD_CREDENTIALS };
  }

  const retryAfterMs = signInRetryAfterMs(email);
  if (retryAfterMs > 0) {
    return {
      error: `Too many failed sign-ins for this email. Try again in ${Math.ceil(retryAfterMs / 60_000)} min.`,
    };
  }

  let operator = await prisma.operator.findUnique({
    where: { email },
    select: { id: true, email: true, passwordHash: true, mustChangePassword: true },
  });

  if (!operator) {
    // First sign-in to a fresh install: create the operator from
    // CHOPPER_ADMIN_EMAIL / CHOPPER_ADMIN_PASSWORD, then verify against it
    // like any other account.
    const bootstrap = await bootstrapFirstOperator();
    if (bootstrap.state === "unconfigured") {
      return {
        error:
          "No operator accounts exist yet. Set CHOPPER_ADMIN_EMAIL and CHOPPER_ADMIN_PASSWORD on the control plane and restart it, then sign in with them.",
      };
    }
    if (bootstrap.state === "invalid") {
      return { error: `Can't create the first operator: ${bootstrap.problem}.` };
    }
    if (bootstrap.state === "created") {
      operator = await prisma.operator.findUnique({
        where: { email },
        select: { id: true, email: true, passwordHash: true, mustChangePassword: true },
      });
    }
  }

  const valid = await verifyPassword(password, operator?.passwordHash ?? (await timingDummyHash()));
  if (!operator || !valid) {
    recordSignInFailure(email);
    // Only wrong passwords for real operators are audited: anyone can submit
    // this form, and logging every made-up email would let them fill the
    // table.
    if (operator) {
      await recordAudit({
        operator: null,
        actor: email,
        action: AuditAction.OPERATOR_SIGN_IN_FAILED,
        targetId: operator.id,
        targetName: operator.email,
      });
    }
    return { error: BAD_CREDENTIALS };
  }

  clearSignInFailures(email);
  await createSession(operator.id);
  await prisma.operator.update({
    where: { id: operator.id },
    data: { lastSignInAt: new Date() },
  });
  await recordAudit({ operator, action: AuditAction.OPERATOR_SIGNED_IN });

  if (operator.mustChangePassword) {
    redirect(`/account/password?next=${encodeURIComponent(next)}`);
  }
  redirect(next);
}

export async function signOut(): Promise<void> {
  const operator = await getOperator();
  await destroySession();
  if (operator) await recordAudit({ operator, action: AuditAction.OPERATOR_SIGNED_OUT });
  redirect("/login");
}
