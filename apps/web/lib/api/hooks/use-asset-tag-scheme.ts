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
  getAssetTagScheme,
  getAssetTagSeedSuggestion,
  updateAssetTagScheme,
} from "../endpoints/asset-tag-scheme";
import { assetTagSchemeKeys } from "../query-keys";

/**
 * Read the org-wide asset-tag scheme (`GET /config/asset-tag-scheme`, ADR-0063 — ADR-0020 data layer).
 * Used by:
 *   - the settings editor (Settings → Instance), to seed the form + render the live preview;
 *   - the asset CREATE form, to hint the next auto-tag when the scheme is enabled.
 *
 * The API never 404s for "unset" — it returns an explicit `enabled: false` default — so `data` is a
 * concrete scheme shape whenever the query resolves. `staleTime` is short so a freshly-saved scheme (or
 * a counter advanced by another create) is reflected without a hard reload; the API is the real gate, so
 * a stale read never authorizes anything.
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
