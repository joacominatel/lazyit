import { z } from "zod";
import { AssetSchema, CreateAssetSchema } from "../asset";

/**
 * Migrator import — the three-layer mapping model (ADR-0069 §4, #627).
 *
 * Wire shapes for what the operator confirms in the "map" step: (1) column → target field,
 * (2) source value → target enum, (3) which fields are FK references resolved by natural key.
 * These describe the SHAPE of a confirmed mapping; the suggestion engine and the resolution engine
 * that consume them are later waves.
 */

/**
 * A single column → field binding. Either the source column drives the field (`column` set) or the
 * operator pins a constant for every row (`constant` set) — required-no-default fields (`name`,
 * `status`) must have one or the other before mapping can complete (ADR-0069 §4). `field` is a key of
 * the target entity's create schema; unmapped columns are dropped before validation.
 */
export const ColumnFieldMappingSchema = z.object({
  /** Target create-schema field key (e.g. `name`, `serial`, `status`, `category`, `model`, `location`). */
  field: z.string().min(1),
  /** Source column header this field reads from (null when a constant is pinned instead). */
  column: z.string().min(1).nullable().default(null),
  /** A fixed value applied to every row, overriding the column (null when a column drives the field). */
  constant: z.string().nullable().default(null),
});

/** One source-value → target-enum binding within a value map (e.g. `"active" → "OPERATIONAL"`). */
export const EnumValueMappingSchema = z.object({
  /** The raw source value as it appears in the file (matched case-insensitively by the coercion layer). */
  from: z.string(),
  /** The canonical enum member it maps to. */
  to: z.string().min(1),
});

/** A confirmed value map for one closed-enum field (e.g. `status`). */
export const EnumFieldMappingSchema = z.object({
  /** The enum field this map applies to. */
  field: z.string().min(1),
  values: z.array(EnumValueMappingSchema),
});

/**
 * Declares that a field is resolved to a FK by natural key rather than taken as a raw value
 * (e.g. `category` by name, `model` by sku-else-name, `location` by name). The resolution ENGINE is a
 * later wave; this only records the operator's intent + which source column feeds the lookup.
 */
export const FkFieldMappingSchema = z.object({
  /** The FK field (e.g. `category`, `model`, `location`). */
  field: z.string().min(1),
  /** Source column whose value is the natural key to resolve (null when a constant is pinned). */
  column: z.string().min(1).nullable().default(null),
  constant: z.string().nullable().default(null),
});

/**
 * A custom field → `Asset.specs` binding (ADR-0069 REDESIGN §5.1): a column with no native home that
 * the operator chooses to passthrough to jsonb under an operator-named `key`. The value is the cell.
 * The `key` is trimmed and capped; the `superRefine` below rejects collisions with native Asset fields
 * and prototype-pollution keys so a custom field can NEVER reach a top-level create-schema field.
 */
export const CustomFieldMappingSchema = z.object({
  /** Source column header this custom field reads from. */
  column: z.string().min(1),
  /** Operator-named key the cell value lands under in `Asset.specs` (trimmed, 1..100). */
  key: z.string().trim().min(1).max(100),
});

/**
 * Model config (ADR-0069 REDESIGN §5.1): brand (manufacturer) + category for newly-created
 * `AssetModel`s. Bound at the MAPPING level (session/column), NOT per `ConflictResolution` — read by
 * the commit's `createReference`. Each is either a column (per-row value) or a pinned constant; all
 * optional (a Model can be created with the `'Unknown'` manufacturer fallback when nothing is set).
 */
export const ModelConfigSchema = z
  .object({
    /** Column whose cell is the manufacturer of the created model. */
    manufacturerColumn: z.string().optional(),
    /** A fixed manufacturer applied to every created model (overrides the column). */
    manufacturerConst: z.string().trim().min(1).optional(),
    /** Column whose cell is the category name (find-or-create). */
    categoryColumn: z.string().optional(),
    /** A fixed category name applied to every created model (overrides the column). */
    categoryConst: z.string().trim().min(1).optional(),
  })
  .optional();

/**
 * The set of keys a `custom.key` must NEVER be — the anti mass-assignment + anti prototype-pollution
 * trust boundary (ADR-0069 REDESIGN §5.1 / §7). Derived from the FULL persisted Asset shape (so it
 * also covers `id`/`createdAt`/`updatedAt`/`deletedAt`, not just the `CreateAsset` keys) — keeps the
 * descriptor↔schema link as the source of truth instead of a hand-maintained guess — plus the
 * prototype-pollution sentinels. A custom field lands EXCLUSIVELY in `payload.specs`; colliding with a
 * native field would let it reach the top level of the strict create schema (mass assignment).
 */
const RESERVED_CUSTOM_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(AssetSchema.shape),
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * The set of keys a mapping TARGET (`columns[].field` / `references[].field`) must NEVER be (MUST-FIX 2).
 * Unlike a custom (specs) key — which must avoid EVERY native field — a target's legitimate values ARE
 * the native create-schema fields (`name`/`serial`/`status`/`modelId`/…). So this is the prototype-
 * pollution sentinels PLUS the persisted-only Asset fields that are NOT in `CreateAssetSchema`
 * (`id`/`createdAt`/`updatedAt`/`deletedAt`) — keys that would either pollute the coerced payload's
 * prototype or mass-assign a non-mappable field. Derived from the schema shapes so it can't drift.
 */
const CREATE_ASSET_KEYS: ReadonlySet<string> = new Set(Object.keys(CreateAssetSchema.shape));
const RESERVED_TARGET_KEYS: ReadonlySet<string> = new Set(
  [...RESERVED_CUSTOM_KEYS].filter((k) => !CREATE_ASSET_KEYS.has(k)),
);

/** Max number of custom (specs) fields per session — a local DoS/abuse cap (ADR-0069 REDESIGN §5.1). */
const MAX_CUSTOM_FIELDS = 64;

/** The full confirmed mapping blob persisted on an `ImportSession` after the map step. */
export const ImportMappingSchema = z
  .object({
    columns: z.array(ColumnFieldMappingSchema),
    enums: z.array(EnumFieldMappingSchema).default([]),
    references: z.array(FkFieldMappingSchema).default([]),
    custom: z.array(CustomFieldMappingSchema).default([]), // → Asset.specs
    modelConfig: ModelConfigSchema, // → created AssetModel brand + category
  })
  .superRefine((m, ctx) => {
    // Anti mass-assignment + anti prototype-pollution (ADR-0069 REDESIGN §5.1 / §7). Custom keys go
    // EXCLUSIVELY to specs, never the top level: reject a key colliding with any native Asset field
    // (name/serial/assetTag/status/specs/modelId/locationId/id/deletedAt/...) or with
    // __proto__/constructor/prototype, and reject duplicate custom keys. The backend specs writer ALSO
    // guards these keys (REDESIGN §4.3, defense-in-depth) so a persisted/corrupt mapping can't bypass it.
    if (m.custom.length > MAX_CUSTOM_FIELDS) {
      ctx.addIssue({
        code: "custom",
        path: ["custom"],
        message: `at most ${MAX_CUSTOM_FIELDS} custom fields are allowed`,
      });
    }
    const seen = new Set<string>();
    m.custom.forEach((c, i) => {
      const key = c.key.trim();
      if (RESERVED_CUSTOM_KEYS.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["custom", i, "key"],
          message: `"${key}" is a reserved field and cannot be a custom (specs) key`,
        });
      }
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["custom", i, "key"],
          message: `duplicate custom key "${key}"`,
        });
      }
      seen.add(key);
    });

    // Anti mass-assignment + anti prototype-pollution at the MAPPING-TARGET layer (MUST-FIX 2). A
    // `columns[].field`/`references[].field` becomes a top-level key on the coerced create payload
    // (`payload[field] = …`) — so a crafted `__proto__`/`constructor`/`prototype` would write to the
    // payload's prototype, and any other reserved/native non-mappable key (`id`/`deletedAt`/…) would be
    // mass-assignable into the strict create schema. A legitimate target is a real descriptor field;
    // a reserved key must NEVER appear as a target. (`coerceRow` is unguarded here — it just assigns —
    // so the contract is enforced at the schema, with the dry-run wrapping each row defensively too.)
    const rejectReservedTarget = (
      field: string,
      where: "columns" | "references",
      i: number,
    ) => {
      if (RESERVED_TARGET_KEYS.has(field)) {
        ctx.addIssue({
          code: "custom",
          path: [where, i, "field"],
          message: `"${field}" is a reserved field and cannot be a mapping target`,
        });
      }
    };
    // Duplicate-target dedup (MUST-FIX 1, belt-and-suspenders): two columns/references mapping to the
    // same field is last-write-wins in `coerceRow` — one column's data is silently dropped. Reject it
    // here so no caller can persist an ambiguous mapping (the FE blocks Continue as the first line).
    const seenColumnFields = new Set<string>();
    m.columns.forEach((c, i) => {
      rejectReservedTarget(c.field, "columns", i);
      if (seenColumnFields.has(c.field)) {
        ctx.addIssue({
          code: "custom",
          path: ["columns", i, "field"],
          message: `duplicate column target "${c.field}"`,
        });
      }
      seenColumnFields.add(c.field);
    });
    const seenReferenceFields = new Set<string>();
    m.references.forEach((r, i) => {
      rejectReservedTarget(r.field, "references", i);
      if (seenReferenceFields.has(r.field)) {
        ctx.addIssue({
          code: "custom",
          path: ["references", i, "field"],
          message: `duplicate reference target "${r.field}"`,
        });
      }
      seenReferenceFields.add(r.field);
    });
  });

export type ColumnFieldMapping = z.infer<typeof ColumnFieldMappingSchema>;
export type EnumValueMapping = z.infer<typeof EnumValueMappingSchema>;
export type EnumFieldMapping = z.infer<typeof EnumFieldMappingSchema>;
export type FkFieldMapping = z.infer<typeof FkFieldMappingSchema>;
export type CustomFieldMapping = z.infer<typeof CustomFieldMappingSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type ImportMapping = z.infer<typeof ImportMappingSchema>;
