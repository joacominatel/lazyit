/**
 * Money helpers (#954, #1470). Amounts are STORED as integer **minor units** (hundredths of the major
 * unit, whatever the currency label says — ADR-0100 §1), but operators type and read **major units**
 * in their own locale. These pure functions convert between the two.
 *
 * Currency is a free-text label with no meaning to lazyit (ADR-0099 §5, ADR-0100 §5): nothing about
 * how an amount is parsed or shown is derived from it. The label, when present, is only printed in
 * front of the amount.
 */

/** The largest amount the wire accepts, in minor units (ADR-0100 §2). */
export const MONEY_MAX = Number.MAX_SAFE_INTEGER;

/** Why a typed amount was refused — each maps to its own inline message. */
export type MoneyParseError = "invalid" | "negative" | "decimals" | "tooLarge";

export type MoneyParseResult =
  | { ok: true; minor: number | null }
  | { ok: false; error: MoneyParseError };

/** The locale's grouping and decimal separators, read from `Intl` rather than hard-coded. */
function separators(locale: string | undefined): { group: string; decimal: string } {
  const parts = new Intl.NumberFormat(locale, { useGrouping: "always" }).formatToParts(1234.5);
  return {
    group: parts.find((p) => p.type === "group")?.value ?? ",",
    decimal: parts.find((p) => p.type === "decimal")?.value ?? ".",
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse what an operator typed, in their UI locale, into minor units.
 *
 * Accepted: plain digits (`1234`), the locale's thousands grouping in groups of three (`1.234` in es,
 * `1,234` in en), and up to two decimals after the locale's decimal separator (`1.234,56` /
 * `1,234.56`). Blank input is `{ ok: true, minor: null }` — "not set".
 *
 * Refused, never guessed: anything else (`invalid` — letters, a currency sign, the other locale's
 * separators such as `1,234.56` in es), a minus sign (`negative`), a third decimal (`decimals` — most
 * often a mistyped grouping separator, so it is never rounded away silently), and an amount past the
 * wire bound (`tooLarge`). The arithmetic is on the digit strings, so no float drift.
 */
export function parseMoneyInput(text: string, locale?: string): MoneyParseResult {
  const value = text.trim();
  if (value === "") return { ok: true, minor: null };
  if (/^[-−]/.test(value)) return { ok: false, error: "negative" };

  const { group, decimal } = separators(locale);
  const g = escapeRegExp(group);
  const d = escapeRegExp(decimal);
  const match = new RegExp(`^(\\d{1,3}(?:${g}\\d{3})+|\\d+)?(?:${d}(\\d*))?$`).exec(value);
  if (!match) return { ok: false, error: "invalid" };

  const whole = (match[1] ?? "").split(group).join("");
  const fraction = match[2] ?? "";
  if (whole === "" && fraction === "") return { ok: false, error: "invalid" };
  if (fraction.length > 2) return { ok: false, error: "decimals" };

  const minor = BigInt(whole || "0") * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  if (minor > BigInt(MONEY_MAX)) return { ok: false, error: "tooLarge" };
  return { ok: true, minor: Number(minor) };
}

/**
 * The one accepted shape the two locales read differently — a single separator followed by exactly
 * three digits (`1.150` in es, `1,150` in en) — is read as a thousands group; for it, this returns the
 * ungrouped whole amount (`"1150"`) so the field can echo how it was read. `null` for any other entry.
 */
export function ambiguousReading(text: string, locale?: string): string | null {
  const { group } = separators(locale);
  const match = new RegExp(`^(\\d{1,3})${escapeRegExp(group)}(\\d{3})$`).exec(text.trim());
  return match ? `${match[1]}${match[2]}` : null;
}

/**
 * Minor units → the amount as entered (ADR-0100 §5): the viewer's locale grouping, no decimals for a
 * whole amount (`150000 → "1,500"` / `"1.500"`), two for a fractional one (`123456 → "1,234.56"` /
 * `"1.234,56"`). A non-blank currency `label` precedes the amount exactly as typed (`"ARS 1.500"`),
 * in every locale. Formatted from the digit string so even the largest amount stays exact.
 */
export function formatMoney(
  minor: number,
  locale?: string,
  label?: string | null,
): string {
  const digits = String(Math.abs(Math.trunc(minor))).padStart(3, "0");
  const whole = digits.slice(0, -2);
  const fraction = digits.slice(-2);
  const fractional = fraction !== "00";
  const amount = new Intl.NumberFormat(locale, {
    useGrouping: "always",
    minimumFractionDigits: fractional ? 2 : 0,
    maximumFractionDigits: fractional ? 2 : 0,
  }).format(`${minor < 0 ? "-" : ""}${whole}.${fraction}` as `${number}`);
  const tag = label?.trim();
  return tag ? `${tag} ${amount}` : amount;
}
