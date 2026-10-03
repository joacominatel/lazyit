/**
 * *Create purchase* from assets selected on the Assets list (ADR-0099 Phase 2, #1477) — the small header form
 * → the `POST /purchase-orders/from-assets` body, and its partial-success result. Pure, so it is tested
 * without React.
 *
 * The API groups the assets into lines (one per model, or per name without one) and links them; it changes no
 * asset field. The form asks only for the header the operator knows: the supplier (typed and resolved like on
 * a purchase), a reference and a currency label. A blank currency is left out, so the API takes the one label
 * every priced asset already shares.
 */

import {
  type CreatePurchaseFromAssets,
  type CreatePurchaseFromAssetsResult,
  CreatePurchaseFromAssetsSchema,
} from "@lazyit/shared";
import { ApiError } from "@/lib/api/client";
import { type FailureView, failureViews } from "./link-apply";

/** The header the dialog collects, as typed. */
export interface FromAssetsForm {
  reference: string;
  currency: string;
}

/** The request body: the selected ids, the resolved supplier, and only the header fields that were filled. */
export function buildFromAssetsPayload(
  assetIds: readonly string[],
  supplierId: string | null,
  form: FromAssetsForm,
): { ok: true; payload: CreatePurchaseFromAssets } | { ok: false } {
  const body: CreatePurchaseFromAssets = { assetIds: [...assetIds] };
  if (supplierId) body.supplierId = supplierId;
  const reference = form.reference.trim();
  if (reference) body.reference = reference;
  const currency = form.currency.trim();
  if (currency) body.currency = currency;
  const parsed = CreatePurchaseFromAssetsSchema.safeParse(body);
  return parsed.success ? { ok: true, payload: parsed.data } : { ok: false };
}

/**
 * After the create: straight to the new purchase when every asset was linked, else the result step naming
 * each asset left out and why (`NOT_FOUND`, `LINKED_ELSEWHERE`) — the purchase exists either way.
 */
export function fromAssetsOutcome(
  result: Pick<CreatePurchaseFromAssetsResult, "linkedAssetIds" | "failed">,
  names: ReadonlyMap<string, { name: string; assetTag: string | null }>,
): { kind: "done"; linked: number } | { kind: "partial"; linked: number; failures: FailureView[] } {
  if (result.failed.length === 0) return { kind: "done", linked: result.linkedAssetIds.length };
  return {
    kind: "partial",
    linked: result.linkedAssetIds.length,
    failures: failureViews(result.failed, names),
  };
}

/**
 * A `409` means none of the selected assets could be linked — each is archived or already on a purchase
 * line — and nothing was created. Any other failure is the generic error.
 */
export function isNothingLinkable(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}
