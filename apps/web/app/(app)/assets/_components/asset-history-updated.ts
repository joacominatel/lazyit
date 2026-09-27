/**
 * Pure payload → text glue for the asset history `UPDATED` event (#1382, ADR-0033 amendment 2026-09-25).
 *
 * The API writes `{ fields: string[] }` — the plain field NAMES that changed, never their values — and a
 * migrator re-import merges `{ source: 'import', sessionId, rowIndex }` into the same row (#1061). The
 * payload is unvalidated jsonb, and rows written before #1382 carry no `fields` at all, so everything here
 * reads tolerantly: a missing / malformed `fields` is an empty list, a non-string entry is dropped, and an
 * unknown field name is kept verbatim so a field added to the API later still shows up.
 */

/** The plain asset fields the API may list, each labelled by the same-named key under `assets.form`. */
export const ASSET_PLAIN_FIELDS = [
  "name",
  "serial",
  "assetTag",
  "notes",
  "company",
  "purchaseDate",
  "warrantyEnd",
  "purchaseCost",
  "usefulLifeMonths",
  "salvageValue",
] as const;

export type AssetPlainField = (typeof ASSET_PLAIN_FIELDS)[number];

const KNOWN_FIELDS: ReadonlySet<string> = new Set(ASSET_PLAIN_FIELDS);

export function isAssetPlainField(field: string): field is AssetPlainField {
  return KNOWN_FIELDS.has(field);
}

export interface UpdatedPayload {
  /** The changed field names, de-duplicated, in payload order. Empty for a legacy or provenance-only row. */
  fields: string[];
  /** True when the row came from a migrator re-import (`source: 'import'`). */
  viaImport: boolean;
}

/** Reads an `UPDATED` payload defensively (tolerant read over legacy and malformed rows). */
export function parseUpdatedPayload(payload: unknown): UpdatedPayload {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const raw = Array.isArray(record.fields) ? record.fields : [];
  const fields: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const field = entry.trim();
    if (field && !fields.includes(field)) fields.push(field);
  }
  return { fields, viaImport: record.source === "import" };
}

/**
 * Joins the changed fields into one comma-separated list, labelling each known field through
 * `labelFor` (the translated form label) and falling back to the raw name for an unknown one.
 * Returns null when there is nothing to list.
 */
export function formatChangedFields(
  fields: readonly string[],
  labelFor: (field: AssetPlainField) => string,
): string | null {
  if (fields.length === 0) return null;
  return fields
    .map((field) => (isAssetPlainField(field) ? labelFor(field) : field))
    .join(", ");
}
