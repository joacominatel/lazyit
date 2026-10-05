import { z } from "zod";
import { int4, money, optionalText, requireAtLeastOneKey } from "./primitives";
import { currencyLabel, nullableCurrencyLabel } from "./purchase-order";

/**
 * Asset — the first-class citizen: a single tracked thing, a concrete instance of an AssetModel
 * living at a Location. Single source of truth for api and web. See docs/02-domain/entities/asset.md
 * and docs/02-domain/asset-centric.md.
 *
 * Date fields are ISO-8601 strings (wire shape) — see the note in asset-category.ts.
 */

/** Lifecycle state of an Asset. */
export const AssetStatusSchema = z.enum([
  "OPERATIONAL",
  "IN_MAINTENANCE",
  "IN_STORAGE",
  "RETIRED",
  "LOST",
  "UNKNOWN",
]);

/**
 * The compact CUSTOM status an asset read inlines (ADR-0101, #1524): an operator-defined name mapped to one
 * built-in {@link AssetStatusSchema} value (`kind`). Defined here rather than in `asset-status-label.ts` so
 * the asset schemas can reference it without an import cycle; that module re-exports it.
 */
export const AssetStatusLabelRefSchema = z.object({
  id: z.cuid(),
  name: z.string(),
  kind: AssetStatusSchema,
  // "#RRGGBB", or null for "use the kind's own colour".
  color: z.string().nullable(),
});

/**
 * Look-ahead window (days) for the "warranty expiring soon" surfaces (#955): both the dashboard
 * "Needs attention" tile and the assets list's `warranty=expiring90d` filter compute the same
 * `(now, now + N days]` window from this one constant, so the tile's count and the pre-filtered list
 * it deep-links into can never diverge. Mirrors the access-grant "expiring soon" pattern.
 */
export const WARRANTY_EXPIRING_WITHIN_DAYS = 90;

/**
 * Warranty-window filter value for `GET /assets` (#955). `expiring90d` = the warranty ends within the
 * next {@link WARRANTY_EXPIRING_WITHIN_DAYS} days and has NOT already lapsed (`now < warrantyEnd <=
 * now + 90d`) — the set the dashboard tile deep-links into; `expired` = the warranty end is already in
 * the past (`warrantyEnd < now`). Assets with no `warrantyEnd` match neither. The `90` in the value is
 * a stable public label, not a knob — the day count lives in `WARRANTY_EXPIRING_WITHIN_DAYS`.
 */
export const AssetWarrantyFilterSchema = z.enum(["expiring90d", "expired"]);

// specs stays an OPEN record here on purpose. Per-category governance (ADR-0007 amendment, #851) is
// ADVISORY: an AssetCategory can declare a `specsSchema` dictionary, but it drives soft warnings +
// hints via `validateSpecsAgainstDictionary` (asset-specs-dictionary.ts) — NOT hard validation. The
// shape never narrows, so legacy rows keep validating; writes add only the structural size bound below.
// Distinct from AssetModel.specs (per-unit vs type-level). See
// docs/03-decisions/0007-flexible-asset-specs-jsonb.md.
const AssetSpecsSchema = z.record(z.string(), z.unknown());

/*
 * Structural WRITE bound on `Asset.specs` (SEC-072 / SEC-032). The shape stays open — any JSON object —
 * but its size is capped so no unbounded structure reaches a recursive consumer or the database. Each
 * cap sits well above the largest specs any legitimate writer produces: the web editor writes flat
 * string rows, an import writes at most 64 string cells, and the reporting agent's facts (written
 * server-side, but re-sent by the web form on every edit) nest about 6 levels, carry up to 5000
 * `software` entries, and no string past 1024 characters (`AgentReportSchema`). Total size is bounded
 * separately by the JSON body limit.
 *
 * Applied to the create/update schemas ONLY. `AssetSchema` (the read shape) keeps the unbounded record,
 * so a row stored before this bound still loads, lists, and exports.
 */

/** Maximum nesting depth; the specs object itself is level 1. */
export const ASSET_SPECS_MAX_DEPTH = 32;
/** Maximum keys in any one object, the top-level specs object included. */
export const ASSET_SPECS_MAX_KEYS = 256;
/** Maximum elements in any one array. */
export const ASSET_SPECS_MAX_ARRAY_LENGTH = 10_000;
/** Maximum length of any string, object keys included. */
export const ASSET_SPECS_MAX_STRING_LENGTH = 10_000;

/**
 * The first bound violation in `specs`, or `null`. Iterative on purpose: this runs on untrusted input,
 * so it must not recurse, and it never descends past {@link ASSET_SPECS_MAX_DEPTH}.
 */
function specsBoundViolation(
  specs: Record<string, unknown>,
): { path: (string | number)[]; message: string } | null {
  type Frame = { value: unknown; depth: number; key: string | number | null; parent: Frame | null };
  const pathOf = (frame: Frame) => {
    const path: (string | number)[] = [];
    for (let f: Frame | null = frame; f !== null && f.key !== null; f = f.parent) path.unshift(f.key);
    return path;
  };
  const stack: Frame[] = [{ value: specs, depth: 1, key: null, parent: null }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { value, depth } = frame;
    if (typeof value === "string") {
      if (value.length > ASSET_SPECS_MAX_STRING_LENGTH) {
        const message = `must be at most ${ASSET_SPECS_MAX_STRING_LENGTH} characters`;
        return { path: pathOf(frame), message };
      }
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    if (depth > ASSET_SPECS_MAX_DEPTH) {
      const message = `must nest at most ${ASSET_SPECS_MAX_DEPTH} levels deep`;
      return { path: pathOf(frame), message };
    }
    if (Array.isArray(value)) {
      if (value.length > ASSET_SPECS_MAX_ARRAY_LENGTH) {
        const message = `must have at most ${ASSET_SPECS_MAX_ARRAY_LENGTH} items`;
        return { path: pathOf(frame), message };
      }
      value.forEach((item, i) => stack.push({ value: item, depth: depth + 1, key: i, parent: frame }));
      continue;
    }
    const keys = Object.keys(value);
    if (keys.length > ASSET_SPECS_MAX_KEYS) {
      return { path: pathOf(frame), message: `must have at most ${ASSET_SPECS_MAX_KEYS} keys` };
    }
    for (const key of keys) {
      if (key.length > ASSET_SPECS_MAX_STRING_LENGTH) {
        const message = `keys must be at most ${ASSET_SPECS_MAX_STRING_LENGTH} characters`;
        return { path: pathOf(frame), message };
      }
      stack.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1, key, parent: frame });
    }
  }
  return null;
}

/** Also bounds `AssetModel.specs`, whose defaults are merged into a new asset's specs (#1329). */
export const AssetSpecsWriteSchema = AssetSpecsSchema.superRefine((specs, ctx) => {
  const violation = specsBoundViolation(specs);
  if (violation) ctx.addIssue({ code: "custom", path: violation.path, message: violation.message });
});

/** The full persisted Asset entity (API representation of the `assets` row). */
export const AssetSchema = z.object({
  id: z.cuid(),
  name: z.string().min(1),
  serial: z.string().nullable(),
  assetTag: z.string().nullable(),
  status: AssetStatusSchema,
  // The asset's optional CUSTOM status (ADR-0101, #1524). `status` above always equals the label's `kind`
  // and drives every rule; the label only names it. `null` = a bare built-in status (every asset that
  // predates custom statuses). `.nullish()` per the new-read-field rule. `statusLabel` is the inlined label
  // on the list and detail reads; the write responses carry the id only.
  statusLabelId: z.cuid().nullish(),
  statusLabel: AssetStatusLabelRefSchema.nullish(),
  specs: AssetSpecsSchema.nullable(),
  notes: z.string().nullable(),
  // Optional GROUPING attribute (ADR-0076, #857) — a Snipe-IT-style "Company" to group/filter/report
  // assets. NOT per-record scoping (anyone with asset:read sees ALL assets; Modo B was decided against,
  // #841). ponytail: free-text + an autocomplete of already-used values — promote to a managed Company
  // entity only if governance (rename/soft-delete) is ever needed.
  company: z.string().nullable(),
  purchaseDate: z.iso.datetime().nullable(),
  warrantyEnd: z.iso.datetime().nullable(),
  // Purchase cost + straight-line depreciation (#954). Money in INTEGER minor units (cents) — `money()`:
  // a 64-bit column, bounded on the wire to MONEY_MAX (ADR-0100). `.nullish()` (not required-nullable)
  // on purpose: an optional key means existing web object-construction sites (Quick View mappers,
  // fixtures) that build an Asset without these keys keep type-checking. The
  // COMPUTED `currentBookValue` lives on the detail read (AssetWithRelationsSchema), not here — it is
  // derived per-request via `computeAssetBookValue`, never a persisted column.
  purchaseCost: money().nullish(),
  usefulLifeMonths: int4({ min: 0 }).nullish(),
  salvageValue: money().nullish(),
  // Optional free-text currency LABEL of purchaseCost / salvageValue (ADR-0099 §5, CEO decision D-C): no ISO
  // list, no conversion. `null` = "No currency" — every asset that predates Purchases. `.nullish()` per the
  // new-read-field rule, so a consumer built against the older shape keeps compiling.
  purchaseCurrency: z.string().nullish(),
  // The purchase line this asset was bought on (ADR-0099 §2). READ-ONLY: no create/update body accepts it;
  // linking and unlinking are their own audited actions (#1473). `null` = no purchase.
  purchaseOrderLineId: z.cuid().nullish(),
  modelId: z.cuid().nullable(),
  locationId: z.cuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

/** The message of the create-time "a status is required" refinement (one source for every schema). */
export const ASSET_STATUS_REQUIRED_MESSAGE = "Give a status or a custom status (statusLabelId)";

/**
 * Payload to create an Asset. Every asset is classified (no default, consistent with Location.type): the
 * body names its built-in `status`, its CUSTOM status (`statusLabelId`, ADR-0101), or both. With a custom
 * status the API derives `status` from the label's `kind`; when both are given and disagree the API
 * answers 400 (only the API knows the label's kind). `serial`/`assetTag` are unique when present; FKs are
 * optional.
 */
export const CreateAssetSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  serial: z.string().trim().min(1).max(200).optional(),
  assetTag: z.string().trim().min(1).max(200).optional(),
  status: AssetStatusSchema.optional(),
  // A live custom status (ADR-0101); a missing or archived one is a 400.
  statusLabelId: z.cuid().optional(),
  specs: AssetSpecsWriteSchema.optional(),
  notes: optionalText(2000),
  // Optional grouping value (ADR-0076). Mirrors `notes` — optional free text, empty coerced to absent.
  company: optionalText(200),
  purchaseDate: z.iso.datetime().optional(),
  warrantyEnd: z.iso.datetime().optional(),
  // Purchase cost + straight-line depreciation (#954) — optional non-negative minor units: `money()` for
  // the two amounts (ADR-0100), `int4()` for the months.
  purchaseCost: money().nullish(),
  usefulLifeMonths: int4({ min: 0 }).nullish(),
  salvageValue: money().nullish(),
  // Currency label of the cost (ADR-0099 §5) — optional free text, blank coerced to absent.
  purchaseCurrency: currencyLabel(),
  modelId: z.cuid().optional(),
  locationId: z.cuid().optional(),
}).refine((v) => v.status !== undefined || v.statusLabelId !== undefined, {
  message: ASSET_STATUS_REQUIRED_MESSAGE,
  path: ["status"],
});

/**
 * Partial update; any subset of the editable fields (an empty body is rejected).
 *
 * Status semantics (ADR-0101): `statusLabelId: "<id>"` sets the custom status AND its built-in `status`
 * (a `status` that disagrees with the label's kind is a 400); `statusLabelId: null` clears the custom
 * status and keeps the built-in one (or sets `status` if also given); `status` alone keeps the current
 * custom status when it maps to that same status and clears it otherwise.
 */
export const UpdateAssetSchema = requireAtLeastOneKey(
  z
    .strictObject({
      name: z.string().trim().min(1).max(200),
      serial: z.string().trim().min(1).max(200),
      assetTag: z.string().trim().min(1).max(200),
      status: AssetStatusSchema,
      // The custom status (ADR-0101): an id sets it (and its kind as `status`), `null` clears it.
      statusLabelId: z.cuid().nullable(),
      specs: AssetSpecsWriteSchema,
      notes: z.string().trim().min(1).max(2000),
      // Optional grouping value (ADR-0076) — mirrors `notes` in the partial update shape.
      company: z.string().trim().min(1).max(200),
      purchaseDate: z.iso.datetime(),
      warrantyEnd: z.iso.datetime(),
      // Purchase cost + straight-line depreciation (#954). `.nullable()` (inside `.partial()`) so a
      // PATCH can CLEAR a value back to unknown (`{ purchaseCost: null }`) as well as set it.
      purchaseCost: money().nullable(),
      usefulLifeMonths: int4({ min: 0 }).nullable(),
      salvageValue: money().nullable(),
      // Currency label of the cost (ADR-0099 §5); `null` clears it back to "No currency".
      purchaseCurrency: nullableCurrencyLabel(),
      modelId: z.cuid(),
      locationId: z.cuid(),
    })
    .partial(),
);

export type AssetStatus = z.infer<typeof AssetStatusSchema>;
export type AssetStatusLabelRef = z.infer<typeof AssetStatusLabelRefSchema>;
export type AssetWarrantyFilter = z.infer<typeof AssetWarrantyFilterSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type CreateAsset = z.infer<typeof CreateAssetSchema>;
export type UpdateAsset = z.infer<typeof UpdateAssetSchema>;
