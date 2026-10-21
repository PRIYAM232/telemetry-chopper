"use server";

import { redirect } from "next/navigation";
import { AuditAction, recordAudit } from "@/lib/audit";
import { destroyOtherSessions, requireOperator, safeNextPath } from "@/lib/auth";
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";

export type ChangePasswordState = { error: string | null; savedAt: number | null };

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export async function changePassword(
  _prev: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const operator = await requireOperator({ allowPendingPasswordChange: true });
  const current = formString(formData, "currentPassword");
  const next = formString(formData, "newPassword");
  const confirm = formString(formData, "confirmPassword");

  const fail = (error: string): ChangePasswordState => ({ error, savedAt: null });

  const row = await prisma.operator.findUnique({
    where: { id: operator.id },
    select: { passwordHash: true },
  });
  if (!row || !(await verifyPassword(current, row.passwordHash))) {
    return fail("Current password is incorrect.");
  }
  const problem = passwordProblem(next);
  if (problem) return fail(`New ${problem}.`);
  if (next !== confirm) return fail("The new passwords don't match.");
  if (next === current) return fail("Choose a password different from the current one.");

  await prisma.operator.update({
    where: { id: operator.id },
    data: { passwordHash: await hashPassword(next), mustChangePassword: false },
  });
  // Anyone else holding this operator's session (another browser, or
  // whoever knew the old password) is signed out.
  await destroyOtherSessions(operator.id);
  await recordAudit({
    operator,
    action: AuditAction.OPERATOR_PASSWORD_CHANGED,
    targetId: operator.id,
    targetName: operator.email,
  });

  // A forced change continues to the page the operator was signing in to.
  if (operator.mustChangePassword) redirect(safeNextPath(formString(formData, "next")));
  return { error: null, savedAt: Date.now() };
}
