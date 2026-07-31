/**
 * Pure helpers behind the healed KB search (#1106 Phase 3): the search-vs-degraded-fallback selection
 * and the client-side query-term highlighter. Both are framework-agnostic (no hooks, no DOM), so they
 * are unit-tested directly (`kb-search.test.ts`) and shared by the list view + the row renderer.
 *
 * WHY a client highlighter: the strong search is Meilisearch body full-text (ADR-0035) via `useSearch`,
 * but the wire `ArticleHit` returns only `title`/`excerpt`/`status`/`slug` — the indexed `content` blob
 * is deliberately NOT retrievable (SEC-061), so there is no server `_formatted` snippet to render. We
 * therefore highlight the query terms wherever they appear in the title/excerpt the hit DOES carry. The
 * body match is still what SURFACED the hit (Meili matched the content); we just can't show that exact
 * sentence without a wire change (Phase 4).
 */

/**
 * Which list the browse view renders:
 *  - `browse`   — no active query: the folder-filtered `useArticles` list.
 *  - `search`   — active query, Meilisearch healthy: body-match hits from `useSearch`.
 *  - `fallback` — active query, Meili unavailable/degraded: the server title+excerpt `useArticles`
 *                 filter (ADR-0021), so search NEVER looks broken right after an upgrade (before a
 *                 `reindex:all`) or during a transient engine outage (#370 degrade-aware).
 */
export type KbSearchMode = "browse" | "search" | "fallback";

export interface KbSearchModeInput {
  /** Whether the (trimmed) query is non-empty. */
  searching: boolean;
  /** `useSearch` returned a payload (vs still loading its first result). */
  hasSearchData: boolean;
  /** The payload carries `degraded: true` — Meili was configured but the read failed (#370). */
  degraded: boolean;
  /** The `useSearch` query errored outright (network/HTTP). */
  searchErrored: boolean;
}

/**
 * Resolve the render mode from the query + `useSearch` state. An outright error OR a resolved
 * `degraded` payload routes to the server fallback; while the first Meili result is still loading we
 * stay in `search` (its loading state renders), never flashing the fallback.
 */
export function resolveKbSearchMode({
  searching,
  hasSearchData,
  degraded,
  searchErrored,
}: KbSearchModeInput): KbSearchMode {
  if (!searching) return "browse";
  if (searchErrored) return "fallback";
  if (hasSearchData && degraded) return "fallback";
  return "search";
}

/** One run of text plus whether it matched a query term (drives a `<mark>` in the renderer). */
export interface HighlightSegment {
  text: string;
  match: boolean;
}

/** Escape a user term so it is treated literally inside the highlight `RegExp`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split `text` into segments, marking every case-insensitive occurrence of any whitespace-separated
 * term in `query`. Longer terms are matched first so an overlapping short term can't pre-empt them.
 * Returns a single unmarked segment when there is no query or no text — the renderer maps `match`
 * runs to `<mark>` and the rest to plain text.
 */
export function highlightSegments(
  text: string,
  query: string,
): HighlightSegment[] {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => escapeRegExp(t))
    .sort((a, b) => b.length - a.length);
  if (terms.length === 0 || !text) return [{ text, match: false }];

  const re = new RegExp(`(${terms.join("|")})`, "gi");
  const segments: HighlightSegment[] = [];
  let lastIndex = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > lastIndex) {
      segments.push({ text: text.slice(lastIndex, idx), match: false });
    }
    segments.push({ text: m[0], match: true });
    lastIndex = idx + m[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), match: false });
  }
  return segments.length > 0 ? segments : [{ text, match: false }];
}
