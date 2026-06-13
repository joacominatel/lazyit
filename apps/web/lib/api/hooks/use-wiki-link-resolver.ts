import { useMemo } from "react";
import type { WikiLinkResolver } from "@/components/markdown-wiki-link-view";
import { useArticles } from "./use-articles";

/**
 * Build a render-time `[[slug]]` resolver (ADR-0059 §3) from the set of articles the caller can see.
 * A `[[slug]]` resolves to a clickable KB link when a LIVE, readable article carries that slug, and
 * renders as a non-clickable "document not created yet" tooltip otherwise (the component decides — this
 * hook only supplies the lookup).
 *
 * The lean article list (`GET /articles`, ADR-0030 — no body, `slug` kept) is the source of live
 * slugs; we pull a wide first page so the common case (a modest KB) resolves fully client-side without
 * a per-link round-trip. There is NO dedicated slug-lookup endpoint yet — see the issue findings; a
 * very large KB whose slugs spill past this page would leave some links rendered as unresolved, which
 * degrades gracefully to the same calm tooltip (never a wrong target, never a crash).
 *
 * Visibility is already enforced server-side: a draft the caller can't read never appears in the list,
 * so a link to it correctly renders unresolved for that caller — the resolver inherits the API gate.
 */
const RESOLVER_PAGE_SIZE = 200;

export function useWikiLinkResolver(): WikiLinkResolver {
  // A wide, unfiltered page of readable articles — the live-slug set for resolution.
  const { data } = useArticles({ limit: RESOLVER_PAGE_SIZE, offset: 0 });

  return useMemo<WikiLinkResolver>(() => {
    const slugs = new Set((data?.items ?? []).map((article) => article.slug));
    return (slug: string) => (slugs.has(slug) ? { slug } : null);
  }, [data]);
}
