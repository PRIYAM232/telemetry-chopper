// Condition operator helpers shared by the New rule form, createRule and the
// rule cards, mirroring the Go data plane (rules.go).

import { ConditionOp } from "@/generated/prisma/enums";

// Operators that compare text, so "ignore case" means something (issue #47).
// The data plane ignores the flag on every other operator.
export const IGNORE_CASE_OPS: ReadonlySet<string> = new Set([
  ConditionOp.EQUALS,
  ConditionOp.CONTAINS,
  ConditionOp.REGEX_MATCH,
]);

// Operators whose value must be a number; the data plane never matches a
// rule whose value doesn't parse.
export const NUMERIC_OPS: ReadonlySet<string> = new Set([
  ConditionOp.GREATER_THAN,
  ConditionOp.LESS_THAN,
]);
