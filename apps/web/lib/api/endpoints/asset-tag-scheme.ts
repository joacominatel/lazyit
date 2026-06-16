import type {
  AssetTagBackfillMode,
  AssetTagBackfillPreview,
  AssetTagBackfillResult,
  AssetTagScheme,
  AssetTagSeedSuggestion,
  UpdateAssetTagScheme,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Pure data-access functions for the org-wide asset-tag scheme (ADR-0063, #363) — the ONLY place that
 * talks to `apiFetch` for the scheme. Hooks (../hooks/use-asset-tag-scheme.ts) wrap these in TanStack
 * Query; the settings editor + the asset-form hint consume the hooks, never these (ADR-0020).
 *
 * Routes mirror apps/api/src/asset-tag-scheme. The GET never 404s for "unset" — the API returns an
 * explicit disabled default (`enabled: false`) so the frontend always has a concrete shape to render.
 * The PUT is gated `settings:manage` server-side (403 for anyone without it). Timestamps come back as
 * ISO strings, not `Date` instances ([[0018]]).
 */
const BASE = "/config/asset-tag-scheme";

/**
 * Read the current scheme (`GET /config/asset-tag-scheme`). Returns the persisted scheme or — when no
 * scheme was ever configured — an explicit `enabled: false` default with the next-allocatable
 * `nextNumber`. Public to any authenticated user (the asset-form hint reads it), unlike the PUT.
 */
export function getAssetTagScheme(signal?: AbortSignal): Promise<AssetTagScheme> {
  return apiFetch<AssetTagScheme>(BASE, { signal });
}

/**
 * Upsert the single config row (`PUT /config/asset-tag-scheme`, `settings:manage`). `enabled` is the
 * required on/off act; `prefix`/`suffix`/`width` shape the template; `startNumber` optionally (re)seeds
 * the counter. Returns the persisted scheme (with the recomputed `nextNumber`). 403 if the caller lacks
 * `settings:manage`; 400 on a body the shared schema rejects.
 */
export function updateAssetTagScheme(
  body: UpdateAssetTagScheme,
): Promise<AssetTagScheme> {
  return apiFetch<AssetTagScheme>(BASE, { method: "PUT", body });
}

/* -------------------------------------------------------------------------- */
/* Existing-estate awareness (ADR-0068, #547)                                  */
/* -------------------------------------------------------------------------- */

/** Query params for the seed-suggestion read — the pattern the editor is currently composing. */
export interface AssetTagSeedSuggestionParams {
  prefix?: string;
  suffix?: string;
  width?: number;
}

/**
 * Read the suggested `startNumber` for a given (prefix, suffix, width) pattern
 * (`GET /config/asset-tag-scheme/seed-suggestion`, ADR-0068 §2). The API parses the numeric body
 * out of LIVE tags matching the pattern and returns `max + 1` (or `1` when nothing matches), plus
 * the `matchedCount` / `maxExistingNumber` the editor surfaces inline. Read-only — it writes
 * nothing and never (re)seeds the counter; the admin clicks to accept the suggestion.
 */
export function getAssetTagSeedSuggestion(
  params: AssetTagSeedSuggestionParams = {},
  signal?: AbortSignal,
): Promise<AssetTagSeedSuggestion> {
  const qs = new URLSearchParams();
  if (params.prefix) qs.set("prefix", params.prefix);
  if (params.suffix) qs.set("suffix", params.suffix);
  if (params.width !== undefined) qs.set("width", String(params.width));
  const search = qs.toString();
  return apiFetch<AssetTagSeedSuggestion>(
    search ? `${BASE}/seed-suggestion?${search}` : `${BASE}/seed-suggestion`,
    { signal },
  );
}

/** Query params for the backfill preview — the scope (mode + optional model) and the page window. */
export interface AssetTagBackfillPreviewParams {
  mode: AssetTagBackfillMode;
  modelId?: string;
  page?: number;
  pageSize?: number;
}

/**
 * Read a page of the backfill preview (`GET /config/asset-tag-scheme/backfill/preview`,
 * ADR-0068 §4) — the LIVE assets a given scope would retag, with their `currentTag → proposedTag`
 * projection. Read-only: it consumes nothing of the counter, so `proposedTag` is indicative, not a
 * promise (apply re-allocates for real). `mode` picks the target set (`untagged-only` vs
 * `normalize-non-conforming`); `modelId` optionally narrows to one AssetModel. `settings:manage`.
 */
export function getAssetTagBackfillPreview(
  params: AssetTagBackfillPreviewParams,
  signal?: AbortSignal,
): Promise<AssetTagBackfillPreview> {
  const qs = new URLSearchParams();
  qs.set("mode", params.mode);
  if (params.modelId) qs.set("modelId", params.modelId);
  if (params.page !== undefined) qs.set("page", String(params.page));
  if (params.pageSize !== undefined) qs.set("pageSize", String(params.pageSize));
  return apiFetch<AssetTagBackfillPreview>(
    `${BASE}/backfill/preview?${qs.toString()}`,
    { signal },
  );
}

/** Body for the backfill apply — the scope plus the ids the operator deselected in the preview. */
export interface AssetTagBackfillApplyBody {
  mode: AssetTagBackfillMode;
  modelId?: string;
  /** Ids deselected across the preview; the apply acts on `(matching − excludeIds)`. */
  excludeIds: string[];
}

/**
 * Apply the backfill (`POST /config/asset-tag-scheme/backfill/apply`, ADR-0068 §3) — the deliberate
 * bulk retag. Forward-only and audited (each retag writes an `AssetHistory` row); there is no bulk
 * undo. Re-allocates for real and re-validates uniqueness per asset under the §1 skip-existing
 * invariant. Returns `{ tagged, skipped }`. `settings:manage` (403 otherwise).
 */
export function applyAssetTagBackfill(
  body: AssetTagBackfillApplyBody,
): Promise<AssetTagBackfillResult> {
  return apiFetch<AssetTagBackfillResult>(`${BASE}/backfill/apply`, {
    method: "POST",
    body,
  });
}
