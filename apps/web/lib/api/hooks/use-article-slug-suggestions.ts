import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getArticles } from "../endpoints/articles";
import { articleKeys } from "./use-articles";

/** Max suggestions surfaced in the `[[` autocomplete — a short, scannable list. */
const SUGGESTION_LIMIT = 8;

/** One `[[slug]]` autocomplete suggestion: the slug to insert and the title to show. */
export interface ArticleSlugSuggestion {
  slug: string;
  title: string;
}

/**
 * Suggest existing article slugs for the editor's `[[` wiki-link autocomplete (ADR-0059 §3). Reuses
 * the existing lean article list (`GET /articles?q=`, ADR-0030 — no body, `slug`/`title` kept) as the
 * slug source: there is NO dedicated slug-search endpoint (see the issue findings), so this rides the
 * standard search. `q` matches title/excerpt server-side; an empty/blank query is idle (the popup only
 * opens once the user has typed inside `[[`). Visibility is enforced server-side — a draft another
 * user can't read never appears, so the author can only link articles they can actually see.
 */
export function useArticleSlugSuggestions(query: string) {
  const trimmed = query.trim();
  const filters = { q: trimmed, limit: SUGGESTION_LIMIT, offset: 0 };

  const { data } = useQuery({
    queryKey: [...articleKeys.list(filters), "slug-suggestions"],
    queryFn: () => getArticles(filters),
    enabled: trimmed.length > 0,
    placeholderData: keepPreviousData,
  });

  const suggestions: ArticleSlugSuggestion[] = (data?.items ?? []).map(
    (article) => ({ slug: article.slug, title: article.title }),
  );
  return suggestions;
}
