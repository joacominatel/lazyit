import { z } from "zod";

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

/** The full confirmed mapping blob persisted on an `ImportSession` after the map step. */
export const ImportMappingSchema = z.object({
  columns: z.array(ColumnFieldMappingSchema),
  enums: z.array(EnumFieldMappingSchema).default([]),
  references: z.array(FkFieldMappingSchema).default([]),
});

export type ColumnFieldMapping = z.infer<typeof ColumnFieldMappingSchema>;
export type EnumValueMapping = z.infer<typeof EnumValueMappingSchema>;
export type EnumFieldMapping = z.infer<typeof EnumFieldMappingSchema>;
export type FkFieldMapping = z.infer<typeof FkFieldMappingSchema>;
export type ImportMapping = z.infer<typeof ImportMappingSchema>;
