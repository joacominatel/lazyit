import type { SearchEntity, SearchResults } from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data-access for cross-entity search (ADR-0035). One read: `GET /search`, which returns a
 * `{ hits, total }` block per requested entity (all five when `entities` is omitted). The only
 * `apiFetch` caller for search — pages/components go through the `useSearch` hook.
 */

const BASE = "/search";

export interface SearchParams {
  /** Query string. The API accepts "" (top documents), but the hook only calls with a real query. */
  q: string;
  /** Restrict to a subset of entities; omit or empty = search all five. */
  entities?: SearchEntity[];
  /** Per-index hit cap (the API clamps to 1..50). */
  limit?: number;
}

/**
 * Run a cross-entity search, building the `?q=&entities=assets,articles&limit=` query string.
 * `signal` is the TanStack Query `queryFn` AbortSignal — forwarding it lets a superseded keystroke's
 * request cancel in-flight instead of running to completion.
 */
export function search(
  { q, entities, limit }: SearchParams,
  signal?: AbortSignal,
): Promise<SearchResults> {
  const params = new URLSearchParams();
  params.set("q", q);
  if (entities && entities.length > 0) params.set("entities", entities.join(","));
  if (limit !== undefined) params.set("limit", String(limit));
  return apiFetch<SearchResults>(`${BASE}?${params.toString()}`, { signal });
}
