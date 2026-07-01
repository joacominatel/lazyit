import { z } from "zod";

/**
 * Asset specs dictionary (ADR-0007 amendment, #851): a per-AssetCategory DECLARATIVE field list
 * that drives ADVISORY validation + autocomplete of `Asset.specs` (jsonb). Single source of truth
 * for api and web. See docs/03-decisions/0007-flexible-asset-specs-jsonb.md and
 * docs/02-domain/entities/asset-category.md.
 *
 * ADVISORY-FIRST: the dictionary NEVER hard-blocks a write. Missing / extra / mistyped fields surface
 * as UI hints + soft warnings via {@link validateSpecsAgainstDictionary}; the API never returns a 400
 * for a spec that doesn't match its category dictionary, and pre-existing rows stay valid untouched.
 * It is a small serializable list — deliberately NOT executable zod and NOT a JSON-Schema engine
 * (ponytail: a minimal `{ key, label, type, required?, enumValues? }[]` is enough; a general schema
 * engine is dead weight for a 5–20-person estate).
 */

/** The value shapes a declared spec field can take. `enum` is a fixed choice list. */
export const SPEC_FIELD_TYPES = ["string", "number", "boolean", "enum"] as const;
export const SpecFieldTypeSchema = z.enum(SPEC_FIELD_TYPES);
export type SpecFieldType = z.infer<typeof SpecFieldTypeSchema>;

/** Bounds — a dictionary is a small human-authored list, not an unbounded schema. */
export const SPEC_FIELD_KEY_MAX = 60;
export const SPEC_FIELD_LABEL_MAX = 100;
export const SPEC_DICTIONARY_FIELDS_MAX = 50;
export const SPEC_ENUM_VALUES_MAX = 50;

/**
 * One declared spec field. `key` is the `Asset.specs` object key it governs; `label` is its human
 * name in the UI; `type` drives the advisory type check; `required` marks a soft "should be filled"
 * hint; `enumValues` is the fixed choice list (required + non-empty when `type === "enum"`).
 */
export const SpecFieldSchema = z
  .strictObject({
    key: z.string().trim().min(1).max(SPEC_FIELD_KEY_MAX),
    label: z.string().trim().min(1).max(SPEC_FIELD_LABEL_MAX),
    type: SpecFieldTypeSchema,
    required: z.boolean().optional(),
    enumValues: z
      .array(z.string().trim().min(1).max(SPEC_FIELD_LABEL_MAX))
      .max(SPEC_ENUM_VALUES_MAX)
      .optional(),
  })
  .superRefine((field, ctx) => {
    if (field.type === "enum" && (field.enumValues?.length ?? 0) === 0) {
      ctx.addIssue({
        code: "custom",
        message: "An enum field must declare at least one enum value",
        path: ["enumValues"],
      });
    }
  });
export type SpecField = z.infer<typeof SpecFieldSchema>;

/**
 * A category's specs dictionary: an ordered list of declared fields with UNIQUE keys. Empty = no
 * governance (the ADR-0007 default — any jsonb object is accepted). Bounded so it stays a small list.
 */
export const AssetSpecsDictionarySchema = z
  .array(SpecFieldSchema)
  .max(SPEC_DICTIONARY_FIELDS_MAX)
  .superRefine((fields, ctx) => {
    const seen = new Set<string>();
    fields.forEach((field, i) => {
      if (seen.has(field.key)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate field key "${field.key}"`,
          path: [i, "key"],
          input: field.key,
        });
      }
      seen.add(field.key);
    });
  });
export type AssetSpecsDictionary = z.infer<typeof AssetSpecsDictionarySchema>;

/** The soft-warning kinds {@link validateSpecsAgainstDictionary} can raise. All advisory. */
export const SPECS_WARNING_CODES = [
  "missingRequired",
  "unknownKey",
  "wrongType",
  "notInEnum",
] as const;
export type SpecsWarningCode = (typeof SPECS_WARNING_CODES)[number];

/** One advisory warning about a single specs key. The web resolves the label/allowed values by key. */
export interface SpecsWarning {
  /** The `Asset.specs` key the warning is about. */
  key: string;
  code: SpecsWarningCode;
}

/** Is a spec value "filled"? (present, non-null, and — for strings — non-blank). */
function isFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

/**
 * Advisory type check for a FILLED value. The web custom-fields editor stores every value as a STRING
 * (ADR-0007), so the numeric / boolean checks are LENIENT — a `"16"` string satisfies a `number`
 * field — otherwise every typed field would warn on real data and the feature would be pure noise.
 * `string` never mismatches; `enum` membership is checked separately against `enumValues`.
 */
function matchesType(value: unknown, type: SpecFieldType): boolean {
  switch (type) {
    case "string":
      return true;
    case "number":
      return typeof value === "number"
        ? Number.isFinite(value)
        : typeof value === "string" &&
            value.trim() !== "" &&
            Number.isFinite(Number(value));
    case "boolean":
      return (
        typeof value === "boolean" ||
        (typeof value === "string" &&
          ["true", "false"].includes(value.trim().toLowerCase()))
      );
    case "enum":
      return true; // enum membership is validated against enumValues, not here.
  }
}

/**
 * Advisory validation of an Asset's `specs` against its category dictionary (ADR-0007 amendment,
 * #851). PURE + framework-agnostic so api and web agree on what "conforms" means. Returns a list of
 * soft WARNINGS — NEVER throws, never blocks. An empty / absent dictionary yields no warnings (the
 * ADR-0007 default: any jsonb object is accepted).
 *
 * Rules: a `required` field whose key is missing / blank → `missingRequired`; a filled value that
 * does not match its declared `type` → `wrongType`; an `enum` value outside `enumValues` →
 * `notInEnum`; a specs key not declared in the dictionary → `unknownKey` (extra keys are allowed,
 * just flagged). Warning order is: declared fields in dictionary order, then undeclared keys.
 */
export function validateSpecsAgainstDictionary(
  specs: Record<string, unknown> | null | undefined,
  dictionary: AssetSpecsDictionary | null | undefined,
): SpecsWarning[] {
  if (!dictionary || dictionary.length === 0) return [];
  const specsObj = specs ?? {};
  const declared = new Set(dictionary.map((f) => f.key));
  const warnings: SpecsWarning[] = [];

  for (const field of dictionary) {
    const value = specsObj[field.key];
    if (!isFilled(value)) {
      // An unfilled optional field is fine; only a required one earns a hint.
      if (field.required) warnings.push({ key: field.key, code: "missingRequired" });
      continue;
    }
    if (field.type === "enum") {
      if (!(field.enumValues ?? []).includes(String(value))) {
        warnings.push({ key: field.key, code: "notInEnum" });
      }
      continue;
    }
    if (!matchesType(value, field.type)) {
      warnings.push({ key: field.key, code: "wrongType" });
    }
  }

  for (const key of Object.keys(specsObj)) {
    if (!declared.has(key)) warnings.push({ key, code: "unknownKey" });
  }

  return warnings;
}
