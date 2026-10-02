import type { Suggestion, SuggestionField } from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Smart-entry suggestions (ADR-0099 §7) — `GET /suggestions/:field`: the values already used for a
 * free-text field, with a use count and last use, ranked by the API by count then recency. The API reads
 * only the sources the caller may read and answers 403 when it may read none; callers treat that as "no
 * suggestions".
 */
export function getSuggestions(
  field: SuggestionField,
  { q, limit }: { q?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<Suggestion[]> {
  const qs = new URLSearchParams();
  if (q) qs.set("q", q);
  if (limit !== undefined) qs.set("limit", String(limit));
  const search = qs.toString();
  return apiFetch<Suggestion[]>(
    search ? `/suggestions/${field}?${search}` : `/suggestions/${field}`,
    { signal },
  );
}
