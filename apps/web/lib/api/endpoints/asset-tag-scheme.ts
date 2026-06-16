import type { AssetTagScheme, UpdateAssetTagScheme } from "@lazyit/shared";
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
