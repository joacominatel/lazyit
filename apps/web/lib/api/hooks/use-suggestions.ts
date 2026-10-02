import type { Suggestion, SuggestionField } from "@lazyit/shared";
import { keepPreviousData, type QueryClient, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import type { SuggestCandidate } from "@/lib/utils/suggest";
import { getSuggestions } from "../endpoints/suggestions";

/** How many most-used values a field loads before anything is typed (the API maximum). */
const TOP_LIMIT = 50;
/** How many matches a typed query loads on top of them. */
const MATCH_LIMIT = 20;

/** Query keys for smart-entry suggestions. Writes that add a value invalidate `all`. */
export const suggestionKeys = {
  all: ["suggestions"] as const,
  list: (field: SuggestionField, q: string) => [...suggestionKeys.all, field, q] as const,
};

/** Refresh every suggestion list after a write that may have added a value. */
export function invalidateSuggestions(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: suggestionKeys.all });
}

/** Each value once, first occurrence wins (the two reads overlap; their counts must not add up). */
export function uniqueSuggestions(lists: readonly (readonly Suggestion[] | undefined)[]): SuggestCandidate[] {
  const seen = new Map<string, SuggestCandidate>();
  for (const list of lists) {
    for (const s of list ?? []) {
      if (!seen.has(s.value)) {
        seen.set(s.value, { value: s.value, count: s.count, lastUsedAt: s.lastUsedAt });
      }
    }
  }
  return [...seen.values()];
}

/**
 * The smart-entry candidates for one free-text field (ADR-0099 §7): the field's most used values, plus
 * the server's matches for what is typed once the text has settled — so a value outside the top list is
 * still found. Ranking, recent values and the near-duplicate hint are `SuggestInput`'s job.
 *
 * A 403 (the caller may read none of the field's sources) settles at once under the app-wide retry rule
 * and simply yields no suggestions; the field stays a plain input. `undefined` until the first read lands.
 */
export function useSuggestions(
  field: SuggestionField,
  text: string,
  { enabled = true }: { enabled?: boolean } = {},
): SuggestCandidate[] | undefined {
  const q = useDebouncedValue(text.trim(), 250);
  const top = useQuery({
    queryKey: suggestionKeys.list(field, ""),
    queryFn: ({ signal }) => getSuggestions(field, { limit: TOP_LIMIT }, signal),
    enabled,
    staleTime: 30 * 1000,
  });
  const matches = useQuery({
    queryKey: suggestionKeys.list(field, q),
    queryFn: ({ signal }) => getSuggestions(field, { q, limit: MATCH_LIMIT }, signal),
    enabled: enabled && q !== "",
    staleTime: 30 * 1000,
    placeholderData: keepPreviousData,
  });
  const topData = top.data;
  const matchData = q === "" ? undefined : matches.data;
  return useMemo(
    () => (topData || matchData ? uniqueSuggestions([matchData, topData]) : undefined),
    [topData, matchData],
  );
}
