import {
  RetryRunOverridesSchema,
  type RetryRunOverrides,
} from "@lazyit/shared";

/**
 * Build the request-scoped {@link RetryRunOverrides} record (ADR-0057 Option 2) from the retry-override
 * dialog's editable rows — a PURE transform so it is unit-testable apart from the form. Each row is a
 * `{ field, value }` pair the operator typed (the field NAME and a template string / literal value).
 *
 * INV-6 reminder: the resulting record is the OPTIONAL `overrides` body of `POST /workflow-runs/:id/retry`.
 * It is request-scoped, applied to the NEXT attempt's render ONLY, and NEVER persisted — this helper just
 * shapes it for the wire; the API merges it into the failed step's mapping for one render and discards it.
 *
 * Rules (mirrors the shared {@link RetryRunOverridesSchema} + the request refine):
 *  - the field name is TRIMMED; the value is kept verbatim (a template may carry meaningful whitespace).
 *  - a row with a blank (whitespace-only) field name is DROPPED — an operator-left-empty row is not a field.
 *  - a LATER row with the same trimmed field name wins (last-write — a single override per field).
 *  - the record is validated against the shared schema; an over-long key/value is rejected at the edge.
 *  - an EMPTY result (no usable rows) yields `overrides: undefined` ⇒ a plain, bodyless retry. This is the
 *    one-click default path: no override ⇒ unchanged resume-from-failed-step behaviour.
 */

/** One editable override row in the dialog (a stable id keeps React keys stable across edits). */
export interface RetryOverrideRow {
  id: string;
  field: string;
  value: string;
}

export type BuildOverridesResult =
  | { ok: true; overrides: RetryRunOverrides | undefined }
  | { ok: false; reason: "invalid" };

/**
 * Fold the dialog rows into a validated `overrides` record (or `undefined` when there is nothing to
 * override). Returns `{ ok: false }` only when a non-empty record FAILS the shared schema (e.g. a key or
 * value exceeds the bound) — the dialog surfaces that as a field error rather than letting the API 400.
 */
export function buildRetryOverrides(
  rows: readonly RetryOverrideRow[],
): BuildOverridesResult {
  const record: Record<string, string> = {};
  for (const row of rows) {
    const field = row.field.trim();
    // A blank field name is an operator-left-empty row, not an override — skip it (the value, if any,
    // has nowhere to land). The value itself is intentionally NOT trimmed (a template can be " {{x}} ").
    if (field.length === 0) {
      continue;
    }
    record[field] = row.value;
  }

  // Nothing usable ⇒ a plain retry (no body). The caller treats `undefined` as the one-click default.
  if (Object.keys(record).length === 0) {
    return { ok: true, overrides: undefined };
  }

  const parsed = RetryRunOverridesSchema.safeParse(record);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, overrides: parsed.data };
}
