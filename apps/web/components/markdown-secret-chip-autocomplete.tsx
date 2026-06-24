"use client";

import { KeyIcon } from "@heroicons/react/24/outline";
import type { CSSProperties } from "react";
import type { HandleSuggestion } from "@lazyit/shared";
import { cn } from "@/lib/utils";

/**
 * Editor-side `{{ lazyit_secret.HANDLE }}` chip autocomplete (ADR-0061 §8). Two pure helpers
 * (token detection + insertion) and the suggestion popup. Wired by `MarkdownEditor` when its
 * `secretChip` prop is set; the data (matching handles) is supplied by the caller via
 * `useHandleSuggestions` — HANDLES (metadata) only, never values.
 *
 * SECURITY: autocomplete lists only handles (public metadata) for vaults the author is a member
 * of. The backend scopes `GET /secret-manager/items/handles` to the caller's vaults. No value
 * is ever suggested, displayed, or embedded in the text.
 */

/** The shape the caller passes to `MarkdownEditor` to enable `{{` autocomplete. */
export interface SecretChipAutocomplete {
  /** Called with the text typed after `{{ lazyit_secret.` so the caller can search by handle. */
  onQueryChange: (query: string) => void;
  /** Current handle suggestions for the latest query (the caller fetches these). */
  suggestions: HandleSuggestion[];
}

/** The trigger prefix that opens the chip autocomplete. */
const TRIGGER = "{{ lazyit_secret.";
const TRIGGER_LEN = TRIGGER.length;

/**
 * Given the full text and the caret offset, return the query typed after `{{ lazyit_secret.`
 * when the caret sits inside an OPEN chip token — or `null` when it does not. A token is
 * "open" only if between the trigger and the caret there is no `}}`, no newline, and no `{`
 * (so a closed `{{ lazyit_secret.foo }}` never re-triggers).
 */
export function activeSecretChipQuery(
  text: string,
  caret: number,
): string | null {
  // Find the last `{{ lazyit_secret.` at or before the caret.
  const open = text.lastIndexOf(TRIGGER, caret - 1);
  if (open === -1) return null;
  const between = text.slice(open + TRIGGER_LEN, caret);
  // A newline, `}` or `{` inside means the token is closed or broken.
  if (/[\n\r{}]/.test(between)) return null;
  return between;
}

/**
 * Insert `{{ lazyit_secret.HANDLE }}` for the open token at `caret`, replacing the trigger +
 * partial handle the user has typed. Returns the new text and the caret offset to place after the
 * `}}`, or `null` when the caret is not inside an open token. Pure — the caller applies it.
 */
export function applySecretChipSuggestion(
  text: string,
  caret: number,
  handle: string,
): { value: string; caret: number } | null {
  const open = text.lastIndexOf(TRIGGER, caret - 1);
  if (open === -1) return null;
  const between = text.slice(open + TRIGGER_LEN, caret);
  if (/[\n\r{}]/.test(between)) return null;
  const insertion = `{{ lazyit_secret.${handle} }}`;
  const value = text.slice(0, open) + insertion + text.slice(caret);
  return { value, caret: open + insertion.length };
}

/**
 * The handle suggestion popup anchored under the caret line (same lightweight pattern as
 * `WikiLinkSuggestions`). Keyboard nav (↑/↓/Enter/Tab/Esc) is owned by the textarea's key
 * handler in `MarkdownEditor`; this renders the list and forwards hover/click.
 * `onMouseDown`-prevent keeps the textarea focused through a click.
 *
 * `style` carries the caret-aware `{ top, left }` `MarkdownEditor` computes so the popup sits just
 * below the line being typed (issue #797) instead of the old fixed top-left that covered it. When
 * unset (caret not yet measured), it falls back to a static top-left anchor.
 */
export function SecretChipSuggestions({
  suggestions,
  activeIndex,
  onHover,
  onSelect,
  style,
}: {
  suggestions: HandleSuggestion[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (handle: string) => void;
  style?: CSSProperties;
}) {
  return (
    <ul
      role="listbox"
      aria-label="Secret handle suggestions"
      style={style}
      className={cn(
        "absolute z-20 max-h-64 w-80 max-w-[calc(100%-1rem)] overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-e3 ring-1 ring-foreground/10",
        // Static fallback anchor used until the caret position is measured.
        style ? undefined : "left-2 top-2",
      )}
    >
      {suggestions.map((suggestion, index) => {
        const active = index === activeIndex;
        return (
          <li key={suggestion.handle} role="none">
            <button
              type="button"
              role="option"
              aria-selected={active}
              // Keep textarea focus (don't blur on mousedown) so the caret/selection survives.
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(suggestion.handle);
              }}
              onMouseEnter={() => onHover(index)}
              className={cn(
                "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none",
                active
                  ? "bg-accent text-accent-foreground"
                  : "text-foreground hover:bg-accent/50",
              )}
            >
              <KeyIcon
                className="size-4 shrink-0 text-pillar-knowledge"
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate font-medium">
                {suggestion.label}
              </span>
              <span className="shrink-0 truncate font-mono text-xs text-muted-foreground">
                {suggestion.handle}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
