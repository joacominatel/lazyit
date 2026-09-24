import { CreateConsumableMovementSchema } from "@lazyit/shared";
import type { FieldErrors, FieldValues, Resolver } from "react-hook-form";

/**
 * Form glue for the movement dialogs (the detailed Add / Remove / Adjust dialog, and the deliver and
 * return dialogs of ADR-0098). They validate the payload they will ACTUALLY send against the shared
 * create schema, instead of a `.pick()` of it: the schema carries cross-field refinements (one target,
 * only on an OUT; `returnOfId` only on an IN), and zod refuses `.pick()` on a refined object — the
 * pick threw at module load. Validating the built payload keeps the one contract the API enforces.
 */

/** One field's first validation problem, in react-hook-form's error shape. */
export interface MovementFieldIssue {
  type: string;
  message: string;
}

/**
 * Parse a built movement payload with `CreateConsumableMovementSchema` and return its problems keyed by
 * top-level payload key (`quantity`, `reason`, `notes`, `targetUserId`, …, `returnOfId`) — the first
 * issue per key. An empty object means the payload is valid.
 */
export function movementPayloadIssues(
  payload: unknown,
): Record<string, MovementFieldIssue> {
  const result = CreateConsumableMovementSchema.safeParse(payload);
  if (result.success) return {};
  const issues: Record<string, MovementFieldIssue> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : "root";
    if (!(key in issues)) {
      issues[key] = { type: issue.code, message: issue.message };
    }
  }
  return issues;
}

/**
 * A react-hook-form resolver from a `validate` function that returns field issues keyed by FORM field
 * name. No issues → the raw form values pass through unchanged (the submit handler builds the payload
 * again from them, so what is validated is what is sent).
 */
export function issuesResolver<T extends FieldValues>(
  validate: (values: T) => Record<string, MovementFieldIssue>,
): Resolver<T> {
  return async (values) => {
    const issues = validate(values);
    if (Object.keys(issues).length === 0) return { values, errors: {} };
    return { values: {}, errors: issues as unknown as FieldErrors<T> };
  };
}
