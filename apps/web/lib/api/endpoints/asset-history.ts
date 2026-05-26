import type { AssetHistory } from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Read-access for the AssetHistory event log (ADR-0033). Append-only, newest first, cursor-paginated
 * on the autoincrement `id`: pass `before` to fetch older events (`id < before`). Raw rows
 * (`performedById` only) — the actor is resolved client-side.
 */

export interface AssetHistoryPageParams {
  /** Per-page cap (API clamps to 1..100, default 50). */
  limit?: number;
  /** Cursor: return events with `id < before` (older than the last seen). */
  before?: number;
}

/** One page of an asset's history, newest first. */
export function getAssetHistory(
  assetId: string,
  { limit, before }: AssetHistoryPageParams = {},
): Promise<AssetHistory[]> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (before !== undefined) params.set("before", String(before));
  const qs = params.toString();
  return apiFetch<AssetHistory[]>(
    qs ? `/assets/${assetId}/history?${qs}` : `/assets/${assetId}/history`,
  );
}
