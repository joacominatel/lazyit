"use client";

import { DocumentTextIcon } from "@heroicons/react/24/outline";
import type { ArticleSlugSuggestion } from "@/lib/api/hooks/use-article-slug-suggestions";
import { cn } from "@/lib/utils";

/**
 * The editor-side `[[slug]]` autocomplete (ADR-0059 §3). Two pure helpers (token detection + insertion)
 * and the suggestion popup. Wired by `MarkdownEditor` when its `wikiLink` prop is set; the data
 * (matching slugs) is supplied by the caller from the article search (there is no dedicated slug-search
 * endpoint — see the issue findings).
 */

/** The shape the caller passes to `MarkdownEditor` to enable `[[` autocomplete. */
export interface WikiLinkAutocomplete {
  /** Called with the text typed after `[[` (the open token's query) so the caller can search. */
  onQueryChange: (query: string) => void;
  /** Current suggestions for the latest query (the caller fetches these). */
  suggestions: ArticleSlugSuggestion[];
}

/**
 * Given the full text and the caret offset, return the query of an OPEN `[[` token the caret sits
 * inside — the substring between the nearest preceding `[[` and the caret — or `null` when the caret
 * is not inside an open wiki-link token. A token is "open" only if, between the `[[` and the caret,
 * there is no `]]`, no newline, and no stray `[` or `]` (so a closed `[[x]]` or a `[normal](link)`
 * never triggers it). The query may be empty (just after `[[`), which still opens the picker.
 */
export function activeWikiLinkQuery(
  text: string,
  caret: number,
): string | null {
  // Find the last `[[` at or before the caret.
  const open = text.lastIndexOf("[[", caret - 1);
  if (open === -1) return null;
  const between = text.slice(open + 2, caret);
  // A newline or any bracket inside means the token is broken/closed — not an open wiki-link.
  if (/[\n\r\]\[]/.test(between)) return null;
  return between;
}

/**
 * Insert `[[slug]]` for the open token at `caret`, replacing the `[[query` the user has typed. Returns
 * the new text and the caret offset to place after the inserted `]]`, or `null` when the caret is not
 * inside an open token (nothing to replace). Pure — the caller applies it to the controlled value.
 */
export function applyWikiLinkSuggestion(
  text: string,
  caret: number,
  slug: string,
): { value: string; caret: number } | null {
  const open = text.lastIndexOf("[[", caret - 1);
  if (open === -1) return null;
  const between = text.slice(open + 2, caret);
  if (/[\n\r\]\[]/.test(between)) return null;
  const insertion = `[[${slug}]]`;
  const value = text.slice(0, open) + insertion + text.slice(caret);
  return { value, caret: open + insertion.length };
}

/**
 * The suggestion popover anchored under the caret line (a simple absolutely-positioned listbox over
 * the textarea — the lightweight choice consistent with ADR-0021's no-heavy-editor stance). Keyboard
 * nav (↑/↓/Enter/Tab/Esc) is owned by the textarea's key handler in `MarkdownEditor`; this renders the
 * list and forwards hover/click. `onMouseDown`-prevent keeps the textarea focused through a click.
 */
export function WikiLinkSuggestions({
  suggestions,
  activeIndex,
  onHover,
  onSelect,
}: {
  suggestions: ArticleSlugSuggestion[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (slug: string) => void;
}) {
  return (
    <ul
      role="listbox"
      aria-label="Article suggestions"
      className="absolute left-2 top-2 z-20 max-h-64 w-72 max-w-[calc(100%-1rem)] overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-e3 ring-1 ring-foreground/10"
    >
      {suggestions.map((suggestion, index) => {
        const active = index === activeIndex;
        return (
          <li key={suggestion.slug} role="none">
            <button
              type="button"
              role="option"
              aria-selected={active}
              // Keep textarea focus (don't blur on mousedown) so the caret/selection survives.
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(suggestion.slug);
              }}
              onMouseEnter={() => onHover(index)}
              className={cn(
                "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none",
                active
                  ? "bg-accent text-accent-foreground"
                  : "text-foreground hover:bg-accent/50",
              )}
            >
              <DocumentTextIcon
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate font-medium">
                {suggestion.title}
              </span>
              <span className="shrink-0 truncate font-mono text-xs text-muted-foreground">
                {suggestion.slug}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
