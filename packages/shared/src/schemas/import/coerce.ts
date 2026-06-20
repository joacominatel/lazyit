/**
 * Migrator import — pure coercion/normalization pre-pass (ADR-0069 §3, #627).
 *
 * CSV is "everything-is-a-string and flat"; the strict `CreateAssetSchema` cannot validate raw rows.
 * This framework-agnostic layer feeds the UNCHANGED create schema (never a looser import schema —
 * drift would break the soft-delete/uniqueness/normalization invariants). The SAME functions run in
 * the web preview and the API commit, so the preview cannot lie. No zod, no deps — pure functions,
 * unit-tested with `bun test`.
 */

/** Tokens that mean "no value" in a source file, compared case-insensitively after trimming. */
const NULL_TOKENS: ReadonlySet<string> = new Set(["", "null", "nil", "n/a", "na", "none", "-", "—"]);

/**
 * `normalizeMatchKey` — the natural-key normalizer (ADR-0069 §5). **Trim-only**, mirroring the
 * schemas' `z.string().trim()`: it does NOT collapse internal whitespace (so `"Dell  Inc"` stays
 * distinct from `"Dell Inc"`, matching how the value is actually stored and uniquely indexed). Used to
 * dedupe distinct conflict values and to match against existing rows.
 */
export function normalizeMatchKey(value: string): string {
  return value.trim();
}

/**
 * Treat `''` / whitespace-only / a null-token as **absent** → return `undefined` so the create
 * schema's `.optional()` / `.default()` fire (ADR-0069 §3). A non-empty value is returned trimmed.
 * This is the gate every other coercion runs through first.
 */
export function coerceAbsent(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (NULL_TOKENS.has(trimmed.toLowerCase())) return undefined;
  return trimmed;
}

/**
 * Coerce a source string to a number, or `undefined` when absent. Returns `NaN` for a present-but-
 * unparseable value so the caller can surface a field-level error (rather than silently dropping it).
 */
export function coerceNumber(value: string | null | undefined): number | undefined {
  const present = coerceAbsent(value);
  if (present === undefined) return undefined;
  // Accept a leading sign, digits, one decimal point; reject thousands separators / junk.
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(present)) return Number.NaN;
  return Number(present);
}

const TRUE_TOKENS: ReadonlySet<string> = new Set(["true", "yes", "y", "1", "t", "on"]);
const FALSE_TOKENS: ReadonlySet<string> = new Set(["false", "no", "n", "0", "f", "off"]);

/**
 * Coerce a source string to a boolean, or `undefined` when absent. Returns `undefined` for an
 * unrecognized token (caller decides whether that is an error or a missing optional).
 */
export function coerceBoolean(value: string | null | undefined): boolean | undefined {
  const present = coerceAbsent(value)?.toLowerCase();
  if (present === undefined) return undefined;
  if (TRUE_TOKENS.has(present)) return true;
  if (FALSE_TOKENS.has(present)) return false;
  return undefined;
}

/**
 * Coerce a source date string to an ISO-8601 instant via `toISOString()`, or `undefined` when absent.
 * `z.iso.datetime()` rejects bare dates (`2024-01-02`) AND numeric-offset RFC-3339 (`+00:00` style), so
 * we re-emit through the Date constructor (ADR-0069 §3). Returns `undefined` for an unparseable value
 * (an invalid Date) — the caller surfaces the field-level error against the schema.
 */
export function coerceDate(value: string | null | undefined): string | undefined {
  const present = coerceAbsent(value);
  if (present === undefined) return undefined;
  const date = new Date(present);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

/**
 * Coerce a source string to a canonical enum member using a case-insensitive **synonym map** layered
 * over the enum's own members (e.g. `{ active: "OPERATIONAL", retired: "RETIRED" }`). Resolution order:
 * exact member (case-insensitive) → synonym (case-insensitive) → `undefined` (caller surfaces the
 * mismatch). `members` is the closed enum; `synonyms` keys are matched lowercased.
 */
export function coerceEnum(
  value: string | null | undefined,
  members: readonly string[],
  synonyms: Readonly<Record<string, string>> = {},
): string | undefined {
  const present = coerceAbsent(value);
  if (present === undefined) return undefined;
  const lower = present.toLowerCase();
  const exact = members.find((m) => m.toLowerCase() === lower);
  if (exact !== undefined) return exact;
  const lowerSynonyms: Record<string, string> = {};
  for (const [k, v] of Object.entries(synonyms)) lowerSynonyms[k.toLowerCase()] = v;
  return lowerSynonyms[lower];
}
