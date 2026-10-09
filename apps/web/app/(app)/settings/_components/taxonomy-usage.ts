/**
 * Pure helpers for the compact taxonomy rows (#1540): the "In use" label a row shows, and the filter
 * box over a pane's list. No React, so the rules are unit-tested.
 */

/** What a taxonomy row counts: assets (asset categories, models, statuses), applications, consumables. */
export type UsageNoun = "assets" | "apps" | "consumables";

/**
 * The "In use" label for a row, as a `settings.taxonomies.usage.*` key and its count — or `null` when
 * the API sent no count (an older API, a single read), in which case the row shows nothing rather
 * than a wrong "Unused". Zero reads as "Unused".
 */
export function usageLabel(
  noun: UsageNoun,
  count: number | null | undefined,
): { key: UsageNoun | "unused"; count: number } | null {
  if (count == null || !Number.isFinite(count) || count < 0) return null;
  return count === 0 ? { key: "unused", count: 0 } : { key: noun, count };
}

/**
 * The rows matching a filter query: a case- and accent-insensitive substring match on any of the
 * given fields. A blank query keeps every row, in order.
 */
export function filterTaxonomy<T>(
  rows: readonly T[],
  query: string,
  fields: (row: T) => readonly (string | null | undefined)[],
): T[] {
  const needle = fold(query.trim());
  if (needle.length === 0) return [...rows];
  return rows.filter((row) =>
    fields(row).some((field) => field != null && fold(field).includes(needle)),
  );
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/**
 * What a bulk delete would detach, from the selected rows' counts: the names of the rows in use, the
 * sum of their counts, and whether every count was known. A category delete is a plain soft delete —
 * nothing is refused — so this only informs the confirmation.
 */
export function bulkUsage(
  rows: readonly { name: string; count: number | null | undefined }[],
): { inUse: string[]; total: number; known: boolean } {
  const inUse: string[] = [];
  let total = 0;
  let known = true;
  for (const row of rows) {
    const label = usageLabel("assets", row.count);
    if (!label) {
      known = false;
      continue;
    }
    if (label.count > 0) {
      inUse.push(row.name);
      total += label.count;
    }
  }
  return { inUse, total, known };
}
