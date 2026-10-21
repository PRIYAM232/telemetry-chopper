// The audit trail (issue #10): one AuditEvent row per change an operator
// makes, plus sign-ins and sign-outs. Rendered at /audit.
//
// Events are written right after the change they describe succeeds. If the
// write fails, the Server Action fails loudly rather than leaving a silent
// gap; the change itself has already committed by then.

import { AuditAction } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import type { CurrentOperator } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export { AuditAction };

export async function recordAudit(event: {
  operator: Pick<CurrentOperator, "id" | "email"> | null;
  // Defaults to the operator's email; set it for a failed sign-in, where
  // there is no operator, only the email that was tried.
  actor?: string;
  action: AuditAction;
  fleetId?: string | null;
  targetId?: string | null;
  targetName?: string | null;
  details?: Prisma.InputJsonValue;
}): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      operatorId: event.operator?.id ?? null,
      actor: (event.actor ?? event.operator?.email ?? "unknown").slice(0, 320),
      action: event.action,
      fleetId: event.fleetId ?? null,
      targetId: event.targetId ?? null,
      targetName: event.targetName ?? null,
      details: event.details,
    },
  });
}

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  RULE_CREATED: "Created rule",
  RULE_PAUSED: "Paused rule",
  RULE_RESUMED: "Resumed rule",
  RULE_DELETED: "Deleted rule",
  RULE_RESTORED: "Restored rule",
  RATE_CARD_UPDATED: "Updated vendor pricing",
  COMMITMENT_UPDATED: "Updated committed volume",
  EGRESS_UPDATED: "Updated cloud egress",
  OPERATOR_SIGNED_IN: "Signed in",
  OPERATOR_SIGN_IN_FAILED: "Failed sign-in",
  OPERATOR_SIGNED_OUT: "Signed out",
  OPERATOR_CREATED: "Added operator",
  OPERATOR_REMOVED: "Removed operator",
  OPERATOR_PASSWORD_CHANGED: "Changed password",
  FLEET_CREATED: "Created fleet",
  FLEET_KEY_ROTATED: "Rotated fleet key",
  FLEET_PREVIOUS_KEY_REVOKED: "Revoked previous fleet key",
};
