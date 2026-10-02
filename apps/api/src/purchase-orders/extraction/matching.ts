/**
 * Normalization for the extraction draft's read-only suggestions (#1477): a supplier by tax ID or name, an
 * asset model by brand and model text. Pure; the service runs the queries. A match is a suggestion the
 * reviewer confirms — extraction never creates or links a record.
 */

/** Legal-form suffixes ignored when names are compared ("Compumundo S.A." = "COMPUMUNDO SA" = "Compumundo"). */
const LEGAL_SUFFIXES = new Set([
  'sa',
  'srl',
  'sas',
  'sau',
  'saic',
  'sacif',
  'sh',
  'sl',
  'slu',
  'inc',
  'llc',
  'ltd',
  'ltda',
  'limited',
  'corp',
  'corporation',
  'co',
  'company',
  'gmbh',
  'ag',
  'bv',
  'plc',
  'spa',
  'sarl',
]);

/** Lower case, accents removed, anything but letters and digits as a space. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * A company name for comparison: folded, single letters joined (`s a` → `sa`, from "S.A."), and trailing
 * legal-form suffixes dropped. Empty when nothing is left.
 */
export function normalizeCompanyName(name: string): string {
  const tokens: string[] = [];
  let letters = '';
  for (const token of fold(name).split(' ').filter(Boolean)) {
    if (token.length === 1 && /[a-z]/.test(token)) {
      letters += token;
      continue;
    }
    if (letters) tokens.push(letters);
    letters = '';
    tokens.push(token);
  }
  if (letters) tokens.push(letters);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(' ');
}

/** A tax ID for comparison: letters and digits only, upper case (`30-71234567-9` = `30712345679`). */
export function normalizeTaxId(taxId: string): string | null {
  const compact = taxId.replace(/[^0-9a-z]/gi, '').toUpperCase();
  return compact.length >= 4 ? compact : null;
}

/** Brand or model text for comparison: letters and digits only (`ThinkPad E14 Gen 5` = `THINKPAD-E14 GEN5`). */
export function compactText(text: string): string {
  return fold(text).replace(/ /g, '');
}

/** The single item that matches, or null when none or several do (an ambiguous match is no match). */
export function uniqueMatch<T>(
  items: readonly T[],
  matches: (item: T) => boolean,
): T | null {
  let found: T | null = null;
  for (const item of items) {
    if (!matches(item)) continue;
    if (found !== null) return null;
    found = item;
  }
  return found;
}
