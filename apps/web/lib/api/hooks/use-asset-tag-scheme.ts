import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  AssetTagBackfillMode,
  UpdateAssetTagScheme,
} from "@lazyit/shared";
import { assetKeys } from "./use-assets";
import {
  type AssetTagBackfillApplyBody,
  applyAssetTagBackfill,
  getAssetTagBackfillPreview,
  getAssetTagNextPreview,
  getAssetTagScheme,
  getAssetTagSeedSuggestion,
  updateAssetTagScheme,
} from "../endpoints/asset-tag-scheme";
import { assetTagSchemeKeys } from "../query-keys";

/**
 * Read the org-wide asset-tag scheme (`GET /config/asset-tag-scheme`, ADR-0063 — ADR-0020 data layer).
 * Used by:
 *   - the settings editor (Settings → Instance), to seed the form fields;
 *   - the asset CREATE form, to learn WHETHER the scheme is on and with which affixes.
 *
 * It is NOT the source of the next tag — `nextNumber` is the raw counter, which the allocator may skip
 * past when that number's tag is already taken (ADR-0068 §1). Rendering it as "the next tag" is the
 * #1180 defect; use {@link useAssetTagNextPreview} for that.
 *
 * The API never 404s for "unset" — it returns an explicit `enabled: false` default — so `data` is a
 * concrete scheme shape whenever the query resolves. It is gated `settings:manage`, so for a non-admin
 * the query 403s and `data` stays undefined; every consumer must degrade gracefully rather than block.
 * `staleTime` is short so a freshly-saved scheme is reflected without a hard reload; the API is the real
 * gate, so a stale read never authorizes anything.
 */
export function useAssetTagScheme() {
  return useQuery({
    queryKey: assetTagSchemeKeys.single(),
    queryFn: ({ signal }) => getAssetTagScheme(signal),
    staleTime: 30 * 1000,
  });
}

/**
 * Upsert the scheme (`PUT /config/asset-tag-scheme`, `settings:manage`). On success it invalidates the
 * scheme query so the editor re-seeds from the persisted truth (the recomputed `nextNumber`, the trimmed
 * affixes) and the asset-form hint refreshes. Toasts / validation-state are owned by the calling editor.
 */
export function useUpdateAssetTagScheme() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateAssetTagScheme) => updateAssetTagScheme(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: assetTagSchemeKeys.all });
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Existing-estate awareness (ADR-0068, #547)                                  */
/* -------------------------------------------------------------------------- */

/** The pattern whose seed suggestion the editor wants — the live (prefix, suffix, width). */
interface SeedSuggestionInput {
  prefix?: string;
  suffix?: string;
  width?: number;
  /** Only fetch when the scheme is enabled (the suggestion is meaningless for a disabled scheme). */
  enabled: boolean;
}

/**
 * Read the suggested `startNumber` for the pattern the operator is composing (ADR-0068 §2). The
 * editor watches its (prefix, suffix, width) fields and passes them here debounced; the suggestion
 * surfaces inline ("N existing tags match — highest IT-1005 — suggested start 1006") with a one-click
 * accept. Read-only: it never (re)seeds the counter, so it is safe to refetch as the operator types.
 * Idle until the scheme is `enabled`. `staleTime` is short — the estate can change under the editor.
 */
export function useAssetTagSeedSuggestion({
  prefix,
  suffix,
  width,
  enabled,
}: SeedSuggestionInput) {
  const params = { prefix, suffix, width };
  return useQuery({
    queryKey: assetTagSchemeKeys.seedSuggestion(params),
    queryFn: ({ signal }) => getAssetTagSeedSuggestion(params, signal),
    enabled,
    staleTime: 10 * 1000,
  });
}

/** The pattern whose next tag to preview, plus the gate that keeps it off the network when idle. */
interface NextPreviewInput {
  prefix?: string;
  suffix?: string;
  width?: number;
  /** Counter floor; omit to let the server use the stored `nextNumber`. */
  from?: number;
  /** Only fetch when a preview is meaningful (the scheme is on / the form is creating). */
  enabled: boolean;
}

/**
 * Read the tag the scheme would allocate next for a pattern (#1180) — the ONLY correct source for
 * "the next tag", and the reason this is a server read rather than a local `renderAssetTag` call.
 *
 * The allocator does not hand out the raw counter: it skips forward past any number whose rendered
 * tag is already on a live asset (ADR-0068 §1). That lookup is bounded server-side
 * (`OCCUPIED_SCAN_LIMIT`) and needs the live estate, so it cannot be reproduced in the browser —
 * rendering `nextNumber` locally is exactly the lie this replaces. Read-only: the counter never
 * advances, so it is safe to refetch as the operator types.
 *
 * Deliberately NO `keepPreviousData`, unlike the backfill preview next to it. Holding the previous
 * pattern's tag while a new pattern resolves would put a real-looking tag under the wrong pattern —
 * a smaller version of the exact defect this fixes. Callers render their own pending state instead;
 * the caller debounces, so the gap is not per-keystroke.
 */
export function useAssetTagNextPreview({
  prefix,
  suffix,
  width,
  from,
  enabled,
}: NextPreviewInput) {
  const params = { prefix, suffix, width, from };
  return useQuery({
    queryKey: assetTagSchemeKeys.nextPreview(params),
    queryFn: ({ signal }) => getAssetTagNextPreview(params, signal),
    enabled,
    staleTime: 10 * 1000,
  });
}

/** The scope + page window for a backfill preview; idle until the wizard opens (`enabled`). */
interface BackfillPreviewInput {
  mode: AssetTagBackfillMode;
  modelId?: string;
  page?: number;
  pageSize?: number;
  /** Only fetch while the wizard is open — keeps the preview off the network until it's needed. */
  enabled: boolean;
}

/**
 * Read a page of the backfill preview (ADR-0068 §4) — the assets a given scope would retag. Driven by
 * the wizard's mode toggle + AssetModel filter + page controls. `keepPreviousData` holds the current
 * page while the next resolves so paging doesn't flash an empty table. Read-only (writes nothing); the
 * `proposedTag` is an indicative projection — apply re-allocates for real under the §1 invariant.
 */
export function useAssetTagBackfillPreview({
  mode,
  modelId,
  page,
  pageSize,
  enabled,
}: BackfillPreviewInput) {
  const params = { mode, modelId, page, pageSize };
  return useQuery({
    queryKey: assetTagSchemeKeys.backfillPreview(params),
    queryFn: ({ signal }) => getAssetTagBackfillPreview(params, signal),
    enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * Apply the backfill (ADR-0068 §3, `settings:manage`). On success it invalidates BOTH the scheme (its
 * `nextNumber` advanced as the counter was consumed) AND every asset list/detail (`assetKeys.all`),
 * since rows just got tagged. The wizard owns the result toast (`tagged`/`skipped`) and closing.
 */
export function useAssetTagBackfillApply() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AssetTagBackfillApplyBody) => applyAssetTagBackfill(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: assetTagSchemeKeys.all });
      void queryClient.invalidateQueries({ queryKey: assetKeys.all });
    },
  });
}
