"use server";

// Server Actions backing the /dashboard rule CRUD.
//
// Every mutation ends with revalidatePath("/dashboard") so the RSC payload
// returned by the action already reflects the new database state — the
// operator sees the change instantly, and the collector picks it up on its
// next policy sync tick.
//
// NOTE: the control plane has no operator authentication yet (the dashboard
// is a trusted local surface in this phase). Server Actions are reachable via
// direct POST, so when operator auth lands, every action here must verify the
// session before mutating — see the Next.js data-security guide.

import { revalidatePath } from "next/cache";
import { ConditionOp, PolicyAction, TargetSignal } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { re2SyntaxError } from "@/lib/re2";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function isEnumValue<T extends Record<string, string>>(
  enumObject: T,
  value: string,
): value is T[keyof T] {
  return Object.values(enumObject).includes(value);
}

// createRule's useActionState result. Validation failures are expected
// operator input errors, so they come back as a value the form renders
// instead of a throw, which production Next.js would replace with a generic
// error page.
export type CreateRuleState = { error: string | null };

function fail(error: string): CreateRuleState {
  return { error };
}

export async function createRule(
  _prev: CreateRuleState,
  formData: FormData,
): Promise<CreateRuleState> {
  const fleetId = formString(formData, "fleetId");
  const name = formString(formData, "name");
  const actionType = formString(formData, "actionType");
  const targetSignal = formString(formData, "targetSignal");
  const conditionField = formString(formData, "conditionField");
  const conditionOp = formString(formData, "conditionOp");
  // EXISTS ignores the value; store the empty string by convention.
  const conditionValue = formString(formData, "conditionValue");

  if (!UUID_RE.test(fleetId)) return fail("invalid fleet id");
  if (!name) return fail("rule name is required");
  if (!conditionField) return fail("condition field is required");
  if (!isEnumValue(PolicyAction, actionType)) return fail("invalid action type");
  if (!isEnumValue(TargetSignal, targetSignal)) return fail("invalid target signal");
  if (!isEnumValue(ConditionOp, conditionOp)) return fail("invalid condition operator");
  if (conditionOp !== ConditionOp.EXISTS && !conditionValue) {
    return fail(`condition value is required for ${conditionOp}`);
  }

  // The data plane compiles REGEX_MATCH patterns with Go's RE2, and a pattern
  // that doesn't compile there is skipped (fail open): a REDACT rule would
  // silently mask nothing. Check with the same grammar before saving, not
  // with JS RegExp, which accepts lookaround and backreferences.
  if (conditionOp === ConditionOp.REGEX_MATCH) {
    const syntaxError = re2SyntaxError(conditionValue);
    if (syntaxError) {
      return fail(
        `condition value is not a valid RE2 pattern (no lookaround or backreferences): ${syntaxError}`,
      );
    }
  }

  // sampleRate is only meaningful for SAMPLE; the data plane skips SAMPLE
  // rules without one, so require it here rather than ship a dead rule.
  let sampleRate: number | null = null;
  if (actionType === PolicyAction.SAMPLE) {
    sampleRate = Number(formString(formData, "sampleRate"));
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 1) {
      return fail("sample rate must be a fraction in (0, 1], e.g. 0.1 for 10%");
    }
  }

  // targetDestination is only meaningful for ROUTE; the data plane skips
  // ROUTE rules without one, so require it here rather than ship a dead rule.
  // Kept identifier-like because operators must mirror the exact string in
  // the collector's routing connector table (otelcol-dev.yaml) — allowing
  // arbitrary text just manufactures unmatchable-typo bugs.
  let targetDestination: string | null = null;
  if (actionType === PolicyAction.ROUTE) {
    targetDestination = formString(formData, "targetDestination");
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(targetDestination)) {
      return fail(
        "destination must be 1-128 chars of letters, digits, . _ / - (e.g. cold-storage)",
      );
    }
  }

  // throttleRate is only meaningful for THROTTLE; the data plane skips
  // THROTTLE rules without a positive rate, so require one here rather than
  // ship a dead rule. throttleGroupBy is optional: blank means one global
  // bucket instead of a bucket per attribute value, and records missing the
  // attribute fall back to the rule's shared default bucket either way.
  let throttleRate: number | null = null;
  let throttleGroupBy: string | null = null;
  if (actionType === PolicyAction.THROTTLE) {
    throttleRate = Number(formString(formData, "throttleRate"));
    if (
      !Number.isInteger(throttleRate) ||
      throttleRate <= 0 ||
      throttleRate > 1_000_000
    ) {
      return fail(
        "throttle rate must be a whole number of events/sec in [1, 1000000]",
      );
    }
    const groupBy = formString(formData, "throttleGroupBy");
    if (groupBy) {
      // Identifier-like for the same reason as targetDestination: this must
      // name a real attribute key (tenant_id, service.name) — free text just
      // manufactures buckets that never match anything.
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(groupBy)) {
        return fail(
          "group-by must be an attribute key: 1-128 chars of letters, digits, . _ / - (e.g. tenant_id)",
        );
      }
      throttleGroupBy = groupBy;
    }
  }

  await prisma.policyRule.create({
    data: {
      fleetId,
      name,
      actionType,
      sampleRate,
      targetDestination,
      throttleRate,
      throttleGroupBy,
      targetSignal,
      conditionField,
      conditionOp,
      conditionValue,
    },
  });

  revalidatePath("/dashboard");
  return { error: null };
}

export async function toggleRuleActive(formData: FormData): Promise<void> {
  const ruleId = formString(formData, "ruleId");
  if (!UUID_RE.test(ruleId)) throw new Error("invalid rule id");

  const rule = await prisma.policyRule.findUnique({
    where: { id: ruleId },
    select: { isActive: true },
  });
  if (!rule) throw new Error("rule not found");

  await prisma.policyRule.update({
    where: { id: ruleId },
    data: { isActive: !rule.isActive },
  });

  revalidatePath("/dashboard");
}

export async function deleteRule(formData: FormData): Promise<void> {
  const ruleId = formString(formData, "ruleId");
  if (!UUID_RE.test(ruleId)) throw new Error("invalid rule id");

  await prisma.policyRule.delete({ where: { id: ruleId } });

  revalidatePath("/dashboard");
}
