import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UpdateAssetTagScheme } from "@lazyit/shared";
import {
  getAssetTagScheme,
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
