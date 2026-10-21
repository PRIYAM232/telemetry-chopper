"use server";

// Server Actions backing /settings/operators. Every operator can add and
// remove others: there are no roles yet, so only give accounts to people
// you would trust with every rule.

import { revalidatePath } from "next/cache";
import { AuditAction, recordAudit } from "@/lib/audit";
import { EMAIL_RE, normalizeEmail, requireOperator } from "@/lib/auth";
import { hashPassword, passwordProblem } from "@/lib/password";
import { prisma } from "@/lib/prisma";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export type AddOperatorState = { error: string | null; added: string | null };

export async function addOperator(
  _prev: AddOperatorState,
  formData: FormData,
): Promise<AddOperatorState> {
  const operator = await requireOperator();
  const email = normalizeEmail(formString(formData, "email"));
  const name = formString(formData, "name").trim();
  const password = formString(formData, "password");

  const fail = (error: string): AddOperatorState => ({ error, added: null });
  if (!EMAIL_RE.test(email) || email.length > 320) return fail("Enter a valid email address.");
  if (name.length > 100) return fail("Name must be at most 100 characters.");
  const problem = passwordProblem(password);
  if (problem) return fail(`Temporary ${problem}.`);

  let created: { id: string };
  try {
    created = await prisma.operator.create({
      // They choose their own password on first sign-in.
      data: {
        email,
        name: name || null,
        passwordHash: await hashPassword(password),
        mustChangePassword: true,
      },
      select: { id: true },
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      return fail(`${email} already has an account.`);
    }
    throw err;
  }
  await recordAudit({
    operator,
    action: AuditAction.OPERATOR_CREATED,
    targetId: created.id,
    targetName: email,
  });

  revalidatePath("/settings/operators");
  return { error: null, added: email };
}

export type RemoveOperatorResult = { ok: true } | { ok: false; error: string };

export async function removeOperator(operatorId: string): Promise<RemoveOperatorResult> {
  const operator = await requireOperator();
  if (typeof operatorId !== "string" || !UUID_RE.test(operatorId)) {
    return { ok: false, error: "Invalid operator id" };
  }
  // Nobody can remove themselves, so the console always keeps at least one
  // operator who can sign in.
  if (operatorId === operator.id) {
    return { ok: false, error: "You can't remove your own account." };
  }

  const target = await prisma.operator.findUnique({
    where: { id: operatorId },
    select: { email: true },
  });
  if (!target) return { ok: false, error: "Operator not found (already removed?)" };

  // Their sessions go with them (cascade), signing them out everywhere.
  // Their audit events stay, with the actor email intact.
  await prisma.operator.delete({ where: { id: operatorId } });
  await recordAudit({
    operator,
    action: AuditAction.OPERATOR_REMOVED,
    targetId: operatorId,
    targetName: target.email,
  });

  revalidatePath("/settings/operators");
  return { ok: true };
}
