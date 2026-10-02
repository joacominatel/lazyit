import { INT4_MAX, MONEY_MAX } from '@lazyit/shared';

/**
 * Deterministic readers for what a purchase document PRINTS (ADR-0099 §11, #1477). The model transcribes
 * amounts, quantities and dates as literal text; lazyit turns the text into values here, so a number in the
 * draft is never one the model computed. When a literal reads two ways and nothing else in the document
 * settles it, the reader says so instead of choosing — blanks over guesses.
 *
 * Amounts are minor units (hundredths, ADR-0100). Locale formats: `1.234,56` and `1,234.56` both read as
 * 123456; spaces, non-breaking spaces and apostrophes group thousands (`1 234,56`, `1'234.56`).
 */

/** A decimal separator a document uses. */
export type DecimalSeparator = '.' | ',';

/** Why an amount could not be read. */
export type AmountFailure =
  /** One separator followed by exactly three digits (`1.150`): 1150 or 1.15, and no hint settles it. */
  | 'AMBIGUOUS'
  /** More than two decimals: amounts are stored in hundredths. */
  | 'TOO_PRECISE'
  /** Not an amount: letters inside it, negative, malformed grouping, or past the largest amount. */
  | 'UNREADABLE';

export type AmountReading =
  { ok: true; minor: number } | { ok: false; reason: AmountFailure };

/** Characters that only ever group thousands: spaces of every width and apostrophes. */
const GROUPING_ONLY = /[\s\u00a0\u2007\u202f\u2009'\u2019]/g;
/** What may surround the number: a currency code or symbol (`USD`, `$`, `u$s`, `€`), never digits. */
const LEADING_LABEL = /^[^\d\-−(]*/;
const TRAILING_LABEL = /[^\d)]*$/;

/**
 * The number part of a printed amount, without its currency label or thousands spaces, or null when what is
 * left is not made of digits and separators only. A sign or parentheses (accounting negatives) are refused
 * by the caller: a purchase amount is never negative (`money()`).
 */
function numberPart(
  text: string,
): { negative: boolean; digits: string } | null {
  const core = text
    .trim()
    .replace(LEADING_LABEL, '')
    .replace(TRAILING_LABEL, '');
  const negative = /^[-−(]/.test(core) || /\)$/.test(core);
  const unsigned = core.replace(/^[-−(]/, '').replace(/\)$/, '');
  const digits = unsigned.replace(GROUPING_ONLY, '');
  if (!/^[\d.,]+$/.test(digits) || !/\d/.test(digits)) return null;
  return { negative, digits };
}

/** Whether `groups` (after the first) are all three digits and the first is 1–3 digits, not a lone 0. */
function validGrouping(groups: string[]): boolean {
  const [first, ...rest] = groups;
  if (!first || first.length > 3 || !/^\d+$/.test(first)) return false;
  if (rest.length > 0 && first === '0') return false;
  return rest.every((group) => /^\d{3}$/.test(group));
}

/** `whole` and `fraction` digit strings → minor units, exactly (bigint), or null past `MONEY_MAX`. */
function toMinor(whole: string, fraction: string): number | null {
  const minor =
    BigInt(whole === '' ? '0' : whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return minor > BigInt(MONEY_MAX) ? null : Number(minor);
}

function decimalReading(whole: string, fraction: string): AmountReading {
  if (fraction.length === 0) return { ok: false, reason: 'UNREADABLE' };
  if (fraction.length > 2) return { ok: false, reason: 'TOO_PRECISE' };
  const minor = toMinor(whole, fraction);
  return minor === null
    ? { ok: false, reason: 'UNREADABLE' }
    : { ok: true, minor };
}

function groupedReading(groups: string[]): AmountReading {
  if (!validGrouping(groups)) return { ok: false, reason: 'UNREADABLE' };
  const minor = toMinor(groups.join(''), '');
  return minor === null
    ? { ok: false, reason: 'UNREADABLE' }
    : { ok: true, minor };
}

/**
 * Read a printed amount into minor units. `decimal` is the document's decimal separator when it is known
 * (see {@link inferDecimalSeparator}); it is consulted only for the one shape that reads two ways — a single
 * separator followed by exactly three digits.
 */
export function readAmount(
  text: string,
  decimal: DecimalSeparator | null = null,
): AmountReading {
  const part = numberPart(text);
  if (!part || part.negative) return { ok: false, reason: 'UNREADABLE' };
  const { digits } = part;
  const dots = digits.split('.').length - 1;
  const commas = digits.split(',').length - 1;

  if (dots === 0 && commas === 0) {
    const minor = toMinor(digits, '');
    return minor === null
      ? { ok: false, reason: 'UNREADABLE' }
      : { ok: true, minor };
  }

  if (dots > 0 && commas > 0) {
    // Both: the LAST one is the decimal separator, it appears once, and the other one groups thousands.
    const sep: DecimalSeparator =
      digits.lastIndexOf('.') > digits.lastIndexOf(',') ? '.' : ',';
    const group = sep === '.' ? ',' : '.';
    if ((sep === '.' ? dots : commas) !== 1) {
      return { ok: false, reason: 'UNREADABLE' };
    }
    const [wholePart, fraction] = digits.split(sep) as [string, string];
    const groups = wholePart.split(group);
    if (!validGrouping(groups)) return { ok: false, reason: 'UNREADABLE' };
    return decimalReading(groups.join(''), fraction);
  }

  const sep: DecimalSeparator = dots > 0 ? '.' : ',';
  const parts = digits.split(sep);
  if (parts.length > 2) {
    // The same separator several times can only group thousands: `1.234.567`.
    return groupedReading(parts);
  }
  const [whole, fraction] = parts as [string, string];
  if (fraction.length !== 3) return decimalReading(whole, fraction);
  // `1.150` / `0,500`: a grouping reading needs a valid first group; a decimal one has three decimals.
  if (!validGrouping([whole, fraction])) {
    return { ok: false, reason: 'TOO_PRECISE' };
  }
  if (decimal === null) return { ok: false, reason: 'AMBIGUOUS' };
  return decimal === sep
    ? { ok: false, reason: 'TOO_PRECISE' }
    : groupedReading([whole, fraction]);
}

/**
 * The decimal separator one literal reveals on its own, or null when it reveals none: both separators (the
 * last one is the decimal), one separator repeated (it groups, so the other is the decimal), or one
 * separator followed by one or two digits (it is the decimal).
 */
export function revealedDecimal(text: string): DecimalSeparator | null {
  const part = numberPart(text);
  if (!part) return null;
  const { digits } = part;
  const dots = digits.split('.').length - 1;
  const commas = digits.split(',').length - 1;
  if (dots > 0 && commas > 0) {
    return digits.lastIndexOf('.') > digits.lastIndexOf(',') ? '.' : ',';
  }
  if (dots === 0 && commas === 0) return null;
  const sep: DecimalSeparator = dots > 0 ? '.' : ',';
  if (dots + commas > 1) return sep === '.' ? ',' : '.';
  const fraction = digits.split(sep)[1] ?? '';
  return fraction.length === 1 || fraction.length === 2 ? sep : null;
}

/**
 * The document's decimal separator, from every literal it prints: the one all the revealing literals agree
 * on, or null when none reveals one or they disagree (a document mixing formats settles nothing).
 */
export function inferDecimalSeparator(
  texts: readonly (string | null | undefined)[],
): DecimalSeparator | null {
  let found: DecimalSeparator | null = null;
  for (const text of texts) {
    if (!text) continue;
    const revealed = revealedDecimal(text);
    if (revealed === null) continue;
    if (found !== null && found !== revealed) return null;
    found = revealed;
  }
  return found;
}

export type QuantityReading =
  | { ok: true; quantity: number }
  | { ok: false; reason: AmountFailure | 'NOT_WHOLE' };

/**
 * Read a printed quantity: an amount (`4`, `4,00`, `1.000` with a known separator) that is a whole number of
 * units, at least one and within int4. `4,5` is `NOT_WHOLE`.
 */
export function readQuantity(
  text: string,
  decimal: DecimalSeparator | null = null,
): QuantityReading {
  const reading = readAmount(text, decimal);
  if (!reading.ok) return reading;
  if (reading.minor % 100 !== 0) return { ok: false, reason: 'NOT_WHOLE' };
  const quantity = reading.minor / 100;
  if (quantity < 1 || quantity > INT4_MAX) {
    return { ok: false, reason: 'NOT_WHOLE' };
  }
  return { ok: true, quantity };
}

/** The order of day and month in a document's numeric dates. */
export type DateOrder = 'DMY' | 'MDY';

const NUMERIC_DATE = /^\s*(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})\s*$/;

/** `YYYY-MM-DD` when it is a real calendar date, else null. */
function isoDay(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function fullYear(text: string): number | null {
  if (text.length === 4) return Number(text);
  if (text.length === 2) return 2000 + Number(text);
  return null;
}

/** The calendar days a numeric date literal can mean, per order. Empty when it is not a numeric date. */
function numericDateReadings(
  text: string,
): { DMY: string | null; MDY: string | null; YMD: string | null } | null {
  const match = NUMERIC_DATE.exec(text);
  if (!match) return null;
  const [, a, b, c] = match as unknown as [string, string, string, string];
  if (a.length === 4) {
    return {
      DMY: null,
      MDY: null,
      YMD: isoDay(Number(a), Number(b), Number(c)),
    };
  }
  const year = fullYear(c);
  if (year === null) return { DMY: null, MDY: null, YMD: null };
  return {
    DMY: isoDay(year, Number(b), Number(a)),
    MDY: isoDay(year, Number(a), Number(b)),
    YMD: null,
  };
}

/**
 * The document's date order, from every numeric date it prints: a first part above 12 can only be a day
 * (`DMY`), a second part above 12 only a day too (`MDY`). Null when no date settles it or they disagree.
 */
export function inferDateOrder(
  texts: readonly (string | null | undefined)[],
): DateOrder | null {
  let found: DateOrder | null = null;
  for (const text of texts) {
    if (!text) continue;
    const match = NUMERIC_DATE.exec(text);
    if (!match || match[1].length === 4) continue;
    const a = Number(match[1]);
    const b = Number(match[2]);
    const order: DateOrder | null =
      a > 12 && b <= 12 ? 'DMY' : b > 12 && a <= 12 ? 'MDY' : null;
    if (order === null) continue;
    if (found !== null && found !== order) return null;
    found = order;
  }
  return found;
}

export type DateReading =
  { ok: true; iso: string; ambiguous: boolean } | { ok: false };

const MODEL_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The day a printed date means, as an ISO datetime at UTC midnight. A NUMERIC literal is read here, never
 * taken from the model: `YYYY-MM-DD`-style is unambiguous; `10/03/2026` is read in the document's order when
 * one is known, and when it reads two ways the model's reading is kept only if it is one of them, flagged
 * `ambiguous`. A WRITTEN date (`10 de marzo de 2026`) is the model's reading, kept only when its year and day
 * are printed in the text. Anything else does not read.
 */
export function readDate(
  text: string,
  modelValue: string | null,
  order: DateOrder | null = null,
): DateReading {
  const modelDay =
    modelValue && MODEL_DAY.test(modelValue.trim())
      ? (() => {
          const [, y, m, d] = MODEL_DAY.exec(modelValue.trim()) as unknown as [
            string,
            string,
            string,
            string,
          ];
          return isoDay(Number(y), Number(m), Number(d));
        })()
      : null;
  const at = (day: string) => `${day}T00:00:00.000Z`;

  const numeric = numericDateReadings(text);
  if (numeric) {
    if (numeric.YMD)
      return { ok: true, iso: at(numeric.YMD), ambiguous: false };
    const readings = [numeric.DMY, numeric.MDY].filter(
      (day): day is string => day !== null,
    );
    const distinct = [...new Set(readings)];
    if (distinct.length === 0) return { ok: false };
    if (order !== null && numeric[order]) {
      return { ok: true, iso: at(numeric[order]), ambiguous: false };
    }
    if (distinct.length === 1) {
      return { ok: true, iso: at(distinct[0]), ambiguous: false };
    }
    return modelDay !== null && distinct.includes(modelDay)
      ? { ok: true, iso: at(modelDay), ambiguous: true }
      : { ok: false };
  }

  if (modelDay === null) return { ok: false };
  const [year, , day] = modelDay.split('-') as [string, string, string];
  const numbers: string[] = text.match(/\d+/g) ?? [];
  const printed =
    numbers.includes(year) && numbers.some((n) => Number(n) === Number(day));
  return printed
    ? { ok: true, iso: at(modelDay), ambiguous: false }
    : { ok: false };
}
