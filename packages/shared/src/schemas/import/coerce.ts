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

/**
 * Parse a possibly locale-formatted numeric string to a JS number in MAJOR units, or `NaN` when it
 * isn't numeric. Handles currency symbols/spaces (stripped), US (`1,234.56`) and LATAM (`1.234,56`)
 * grouping+decimal, and accounting parentheses (`(500)` → -500). Takes an already-present (trimmed,
 * non-absent) string — the public coercers gate on `coerceAbsent` first.
 *
 * ponytail: the decimal separator is the LAST `.`/`,` followed by exactly 1-2 digits at end of string;
 * every other `.`/`,` is a thousands separator that gets stripped. Ceiling: a lone 3-digit group like
 * `1.234` reads as thousands (1234), never as a genuine 3-decimal value; a 3+ decimal fraction
 * (`1.2345`) loses the separator and reads as an integer. Fine for money (≤2 decimals) — the common
 * Snipe-IT / spreadsheet case. Upgrade path: take an explicit locale/decimal hint from the mapping.
 */
function parseLocaleNumber(present: string): number {
  let sign = 1;
  let s = present.trim();
  // Accounting parentheses wrap a negative: (500) → -500.
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) {
    sign = -1;
    s = paren[1].trim();
  }
  // A leading sign sitting outside the digits (before symbol-strip): -$5 / +5.
  if (s.startsWith("-")) {
    sign = -sign;
    s = s.slice(1).trim();
  } else if (s.startsWith("+")) {
    s = s.slice(1).trim();
  }
  // Strip everything that isn't a digit or a separator (currency symbols, spaces, letters).
  s = s.replace(/[^\d.,]/g, "");
  if (s === "") return Number.NaN;
  // Decimal separator = the last `.`/`,` with exactly 1-2 trailing digits at end of string.
  const dec = /[.,](\d{1,2})$/.exec(s);
  let intPart: string;
  let fracPart: string;
  if (dec) {
    intPart = s.slice(0, s.length - dec[0].length).replace(/[.,]/g, "");
    fracPart = dec[1];
  } else {
    intPart = s.replace(/[.,]/g, "");
    fracPart = "";
  }
  if (intPart === "" && fracPart === "") return Number.NaN;
  const num = Number(`${intPart || "0"}.${fracPart || "0"}`);
  return Number.isNaN(num) ? Number.NaN : sign * num;
}

/**
 * Coerce a source money string (major units — dollars/pesos) to INTEGER MINOR UNITS (cents), or
 * `undefined` when absent. Rounds to the nearest cent. Returns `NaN` for a present-but-unparseable
 * value so the caller surfaces a field-level error (mirrors `coerceNumber`). Negatives (incl. the
 * accounting-parentheses form) are returned as-is — the `int4({ min: 0 })` money schema then rejects
 * them with a field error rather than this layer silently dropping the value.
 */
export function coerceMoneyMinorUnits(value: string | null | undefined): number | undefined {
  const present = coerceAbsent(value);
  if (present === undefined) return undefined;
  const major = parseLocaleNumber(present);
  if (Number.isNaN(major)) return Number.NaN;
  return Math.round(major * 100);
}

/**
 * Coerce a source string to an integer (e.g. depreciation months), or `undefined` when absent.
 * Locale-tolerant like `coerceMoneyMinorUnits` but keeps MAJOR units. A non-integer input (`12.5`) is
 * returned as the parsed number so the `int4` schema raises the field error; unparseable → `NaN`.
 */
export function coerceInteger(value: string | null | undefined): number | undefined {
  const present = coerceAbsent(value);
  if (present === undefined) return undefined;
  return parseLocaleNumber(present);
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
 * exact member (case-insensitive) → synonym (case-insensitive) → **parenthetical fallback** → `undefined`
 * (caller surfaces the mismatch). `members` is the closed enum; `synonyms` keys are matched lowercased.
 *
 * Parenthetical fallback (#1049): Snipe-IT exports a status as `"<Custom Label> (<statusMeta>)"` — e.g.
 * `"Nueva (deployed)"`. When the whole string matches nothing, we retry the token inside the LAST
 * parentheses (`deployed`) against the same member/synonym table. This lets a synonym for the meta word
 * cover every org's arbitrary label, instead of enumerating each custom label verbatim.
 */
export function coerceEnum(
  value: string | null | undefined,
  members: readonly string[],
  synonyms: Readonly<Record<string, string>> = {},
): string | undefined {
  const present = coerceAbsent(value);
  if (present === undefined) return undefined;
  const lowerSynonyms: Record<string, string> = {};
  for (const [k, v] of Object.entries(synonyms)) lowerSynonyms[k.toLowerCase()] = v;
  const resolve = (token: string): string | undefined => {
    const lower = token.trim().toLowerCase();
    const exact = members.find((m) => m.toLowerCase() === lower);
    return exact ?? lowerSynonyms[lower];
  };
  const direct = resolve(present);
  if (direct !== undefined) return direct;
  const paren = present.match(/\(([^)]*)\)\s*$/);
  return paren ? resolve(paren[1]) : undefined;
}
