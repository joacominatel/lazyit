import type {
  AssetStatus,
  AssetStatusLabel,
  CreateAssetStatusLabel,
  DeleteAssetStatusLabelResult,
  UpdateAssetStatusLabel,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data-access for custom asset statuses (ADR-0101, #1524) — operator-named labels, each mapped to one
 * built-in `AssetStatus` (its `kind`). Routes mirror apps/api/src/asset-status-labels. The API gates
 * them on the category permissions: reads `category:read`, writes `category:write`, archive/restore
 * `category:delete`; the archived list (`deleted: "only"`) stays ADMIN-only (ADR-0041).
 */

const BASE = "/asset-status-labels";

/**
 * Every live custom status (unpaged — a team defines a handful), each with its live `assetCount`, ordered
 * by built-in kind, then `order`, then name. `deleted: "only"` lists the archived ones (ADMIN).
 */
export function getAssetStatusLabels(
  params: { deleted?: "only" } = {},
  signal?: AbortSignal,
): Promise<AssetStatusLabel[]> {
  const path = params.deleted ? `${BASE}?deleted=${params.deleted}` : BASE;
  return apiFetch<AssetStatusLabel[]>(path, { signal });
}

export function createAssetStatusLabel(
  data: CreateAssetStatusLabel,
): Promise<AssetStatusLabel> {
  return apiFetch<AssetStatusLabel>(BASE, { method: "POST", body: data });
}

/** Partial update. A `kind` change while any asset carries the custom status is a 409. */
export function updateAssetStatusLabel(
  id: string,
  data: UpdateAssetStatusLabel,
): Promise<AssetStatusLabel> {
  return apiFetch<AssetStatusLabel>(`${BASE}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: data,
  });
}

/**
 * Where the assets of an archived custom status go: another live custom status, or a bare built-in
 * status. Required (exactly one) when any asset — live or archived — carries it.
 */
export type AssetStatusLabelReassign =
  | { reassignLabelId: string }
  | { reassignStatus: AssetStatus };

/** The DELETE query string for a reassign target (pure; exported for its test). */
export function reassignSearchParams(
  target: AssetStatusLabelReassign,
): URLSearchParams {
  const params = new URLSearchParams();
  if ("reassignLabelId" in target) {
    params.set("reassignLabelId", target.reassignLabelId);
  } else {
    params.set("reassignStatus", target.reassignStatus);
  }
  return params;
}

/**
 * Archive a custom status. Its assets move to `target` in the same transaction (each with a
 * `STATUS_CHANGED` history row); returns the archived row plus `movedAssetCount`.
 */
export function deleteAssetStatusLabel(
  id: string,
  target: AssetStatusLabelReassign,
): Promise<DeleteAssetStatusLabelResult> {
  return apiFetch<DeleteAssetStatusLabelResult>(
    `${BASE}/${encodeURIComponent(id)}?${reassignSearchParams(target).toString()}`,
    { method: "DELETE" },
  );
}

/** Restore an archived custom status (it comes back with no assets). A live name collision is a 409. */
export function restoreAssetStatusLabel(id: string): Promise<AssetStatusLabel> {
  return apiFetch<AssetStatusLabel>(
    `${BASE}/${encodeURIComponent(id)}/restore`,
    { method: "POST" },
  );
}
