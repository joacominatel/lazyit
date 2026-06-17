/**
 * Migrator import — coercion-under-mapping (ADR-0069 §3/§4/§5, #631 wave 3).
 *
 * Wave 1 gave us the per-cell coercion primitives (`coerce.ts`), the asset descriptor (which fields
 * exist, which are FK references, the enum synonym maps) and the mapping wire shape (column→field /
 * value→enum / field→FK). This layer welds them: given ONE raw source row and a confirmed mapping, it
 * produces (a) the coerced create payload — the strict-schema input, with empty cells OMITTED so the
 * schema's `.optional()`/`.default()` fire — and (b) the raw natural-key strings for the FK fields,
 * which the API's resolution engine maps to existing ids (this layer never touches the DB).
 *
 * Pure + framework-agnostic (no zod, no Prisma) so the SAME function runs in the web preview and the
 * API dry-run/commit — the preview cannot lie (ADR-0069 §3). Unit-tested with `bun test`.
 */

import { coerceAbsent, coerceDate, coerceEnum } from "./coerce";
import type { ImportDescriptor } from "./descriptor";
import type { ImportMapping } from "./mapping";

/**
 * The result of coercing one row under a mapping:
 * - `payload` — the non-FK create-schema input (empty cells omitted) to feed `CreateAssetSchema.safeParse`.
 * - `references` — the raw natural-key string per FK field the operator declared (e.g. `modelId → "Latitude 5520"`),
 *   for the resolution engine. Absent cells are omitted (no lookup, no link).
 * - `enumMisses` — closed-enum fields whose source value matched neither a member nor a synonym/value-map
 *   (e.g. `status: "frobnicated"`); surfaced so the caller can raise a field-level error rather than
 *   silently dropping the value (which would let a wrong default through).
 */
export interface CoercedRow {
  payload: Record<string, unknown>;
  references: Record<string, string>;
  enumMisses: { field: string; value: string }[];
}

/** Which create-schema fields are ISO-date fields (re-emitted via `coerceDate`). Phase 1: Asset. */
const DATE_FIELDS: ReadonlySet<string> = new Set(["purchaseDate", "warrantyEnd"]);

/**
 * Resolve the source value for a mapped field: a pinned `constant` wins over the `column`'s cell; an
 * unmapped field (neither set) yields `undefined`. Mirrors the mapping model (ADR-0069 §4): a constant
 * is applied to every row, otherwise the named column drives it.
 */
function sourceValue(
  raw: Record<string, string>,
  binding: { column: string | null; constant: string | null },
): string | undefined {
  if (binding.constant !== null) return binding.constant;
  if (binding.column !== null) return raw[binding.column];
  return undefined;
}

/**
 * Build the per-field value-map (source→enum) the operator confirmed in the map step, keyed by source
 * value, to feed `coerceEnum`'s synonym slot. Layered OVER the descriptor's built-in synonyms so an
 * operator's explicit binding (`"WIP" → "IN_MAINTENANCE"`) extends, never replaces, the defaults.
 */
function valueMapFor(
  mapping: ImportMapping,
  field: string,
): Record<string, string> {
  const entry = mapping.enums.find((e) => e.field === field);
  if (!entry) return {};
  const out: Record<string, string> = {};
  for (const { from, to } of entry.values) out[from] = to;
  return out;
}

/**
 * Coerce one raw source row under a confirmed mapping + the entity descriptor. Drops unmapped fields
 * (the strict schema 400s on unknowns), omits empty cells (so defaults fire), routes enum fields
 * through the synonym + value-map, dates through `coerceDate`, and pulls FK fields out as raw natural
 * keys for the resolver. Everything else is trimmed-or-absent text.
 */
export function coerceRow(
  raw: Record<string, string>,
  mapping: ImportMapping,
  descriptor: ImportDescriptor<unknown>,
): CoercedRow {
  const payload: Record<string, unknown> = {};
  const references: Record<string, string> = {};
  const enumMisses: { field: string; value: string }[] = [];

  // The fields the operator declared as FK references — resolved by natural key, NOT placed in the
  // create payload (the payload carries already-resolved ids only; this layer surfaces the raw key).
  const fkFields = new Set(mapping.references.map((r) => r.field));

  // 1. FK references → raw natural-key strings (absent cells omitted).
  for (const ref of mapping.references) {
    const value = coerceAbsent(sourceValue(raw, ref));
    if (value !== undefined) references[ref.field] = value;
  }

  // 2. Column/constant-driven fields → coerced payload.
  for (const col of mapping.columns) {
    const field = col.field;
    if (fkFields.has(field)) continue; // resolved above, never a payload value.

    const enumMap = (
      descriptor.enumValueMaps as Record<
        string,
        { members: readonly string[]; synonyms: Record<string, string> } | undefined
      >
    )[field];
    if (enumMap) {
      const rawValue = coerceAbsent(sourceValue(raw, col));
      if (rawValue === undefined) continue; // absent → let the schema's requiredness decide.
      const coerced = coerceEnum(rawValue, enumMap.members, {
        ...enumMap.synonyms,
        ...valueMapFor(mapping, field),
      });
      if (coerced === undefined) {
        enumMisses.push({ field, value: rawValue });
        continue; // do NOT write a bad value; surfaced as a miss for a field-level error.
      }
      payload[field] = coerced;
      continue;
    }

    if (DATE_FIELDS.has(field)) {
      const present = coerceAbsent(sourceValue(raw, col));
      if (present === undefined) continue;
      const iso = coerceDate(present);
      // An unparseable date → keep the raw value so `CreateAssetSchema.safeParse` raises the field
      // error (rather than silently dropping it, which would look like an absent optional).
      payload[field] = iso ?? present;
      continue;
    }

    const text = coerceAbsent(sourceValue(raw, col));
    if (text !== undefined) payload[field] = text;
  }

  return { payload, references, enumMisses };
}
