import { z } from "zod";
import { AssetSchema, AssetStatusSchema } from "./asset";
import { int4, optionalText } from "./primitives";

/**
 * Bulk receiving (ADR-0089 Part A, issue #1029) — mint N assets from ONE AssetModel in a single action
 * ("we just received 20 identical ThinkPads"). Single source of truth for `api` (validation + emit) and
 * `web` (the "Receive stock" form). See docs/03-decisions/0089-bulk-receiving-and-checkout-acknowledgement.md.
 *
 * The endpoint is a LOOP over the existing single-asset create path — each unit is its OWN transaction
 * with its OWN independent asset-tag-counter commit (ADR-0063), exactly as the import commit does per
 * row. So PARTIAL SUCCESS is the correct outcome, surfaced by {@link ReceiveAssetsResultSchema.failed}.
 *
 * Date fields are ISO-8601 strings (wire shape). `purchaseCost` is INTEGER minor units (cents), the
 * SAME #954 convention as CreateAssetSchema — it flows through the create path un-re-coerced (the
 * major→minor coercion lives in the web form, never here nor in the api).
 */

/**
 * Hard maximum units one receive request may mint (bounds the sequential create() fan-out: up to this
 * many transactions + search upserts). A DEDICATED cap — NOT the batch-ids cap — because the semantic is
 * "how many assets to create", not "how many ids to mutate". Do not raise without revisiting ADR-0089.
 */
export const RECEIVE_ASSETS_MAX_QUANTITY = 200;

/**
 * Payload to bulk-receive assets. `modelId` is REQUIRED (a receive is inherently model-scoped — the
 * model name feeds each minted unit's default `name` "<ModelName> #<seq>"). The rest are the shared
 * fields applied to EVERY unit. `serials` is optional and must be empty OR contain exactly `quantity`
 * entries (a length mismatch is a 400 up front, before any write); when present, `serials[i]` is applied
 * to unit `i`, otherwise the units are serial-less. `company`/`notes` reuse {@link optionalText} (an
 * empty string coerces to absent). Duplicate serials within the batch (or colliding with a live serial)
 * are NOT pre-validated — the DB unique constraint catches them as a per-unit failure (partial success).
 */
export const ReceiveAssetsSchema = z
  .strictObject({
    modelId: z.cuid(),
    quantity: int4({ min: 1, max: RECEIVE_ASSETS_MAX_QUANTITY }),
    status: AssetStatusSchema,
    locationId: z.cuid().optional(),
    company: optionalText(200),
    purchaseDate: z.iso.datetime().optional(),
    // Minor units (#954) — forwarded verbatim to create(); NEVER re-coerced in shared or api.
    purchaseCost: int4({ min: 0 }).nullish(),
    notes: optionalText(2000),
    serials: z.array(z.string().trim().min(1).max(200)).optional(),
  })
  .refine(
    (v) =>
      v.serials === undefined ||
      v.serials.length === 0 ||
      v.serials.length === v.quantity,
    {
      message: "serials must be empty or contain exactly `quantity` entries",
      path: ["serials"],
    },
  );

/**
 * The bulk-receive result envelope (ADR-0089 A2). `created` are the assets that landed (full Asset wire
 * shape); `failed` lists the per-unit failures by 0-based batch index with a short reason. HTTP 201 when
 * ≥1 created; an all-failed batch is still 201 with `created: []` — `failed` is the honest partial signal
 * (mirrors the import row-level FAILED reporting). Brand-new, fetch-parsed only, so plain required fields
 * (not `.nullish()`) are correct — the shared-package "new read field ⇒ nullish" rule guards fields ADDED
 * to a schema web construction sites build, not a wholly-new response the web only ever reads.
 */
export const ReceiveAssetsResultSchema = z.object({
  created: z.array(AssetSchema),
  failed: z.array(
    z.object({
      index: z.number().int().min(0),
      error: z.string(),
    }),
  ),
});

export type ReceiveAssets = z.infer<typeof ReceiveAssetsSchema>;
export type ReceiveAssetsResult = z.infer<typeof ReceiveAssetsResultSchema>;
