import type { SearchEntity } from "@lazyit/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { search } from "../endpoints/search";

/**
 * Query keys for cross-entity search. Read-only — nothing invalidates these; results just expire by
 * `staleTime`. Hand-written (not `createQueryKeys`) for the bespoke `{ q, entities, limit }` shape.
 */
export const searchKeys = {
  all: ["search"] as const,
  query: (q: string, entities: SearchEntity[] | undefined, limit: number) =>
    [...searchKeys.all, { q, entities: entities ?? null, limit }] as const,
};

const DEFAULT_LIMIT = 8;

export interface UseSearchOptions {
  q: string;
  entities?: SearchEntity[];
  limit?: number;
  /** Gate the request (e.g. palette closed). Combined with a non-empty query. */
  enabled?: boolean;
}

/**
 * Cross-entity search (ADR-0035). Disabled unless `enabled` AND the (trimmed) query is non-empty, so
 * an empty palette never hits the API. `keepPreviousData` holds the last results on screen while the
 * next debounced query resolves — no flash of empty between keystrokes.
 */
export function useSearch({
  q,
  entities,
  limit = DEFAULT_LIMIT,
  enabled = true,
}: UseSearchOptions) {
  const trimmed = q.trim();
  return useQuery({
    queryKey: searchKeys.query(trimmed, entities, limit),
    queryFn: ({ signal }) => search({ q: trimmed, entities, limit }, signal),
    enabled: enabled && trimmed.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}
