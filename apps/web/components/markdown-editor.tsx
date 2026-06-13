"use client";

import {
  CodeBracketIcon,
  EyeIcon,
  ViewColumnsIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import {
  type KeyboardEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownView } from "@/components/markdown-view";
import {
  type WikiLinkAutocomplete,
  WikiLinkSuggestions,
  activeWikiLinkQuery,
  applyWikiLinkSuggestion,
} from "@/components/markdown-wiki-link-autocomplete";
import { cn } from "@/lib/utils";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  placeholder?: string;
  invalid?: boolean;
  /**
   * Optional `[[slug]]` wiki-link autocomplete (ADR-0059 §3). When provided, typing `[[` inside the
   * source pane opens a slug picker fed by `suggestions` (the caller fetches them from the article
   * search); `onQueryChange` is called with the text the user has typed after `[[` so the caller can
   * drive that search. Selecting a suggestion inserts `[[slug]]`. Omit for a plain editor.
   */
  wikiLink?: WikiLinkAutocomplete;
}

/** The three editor layouts. `split` = source + live preview side-by-side; `write` = source
 *  full-width; `preview` = rendered full-width. The toggle (issue #310) lets the author trade
 *  the split for a single full-width pane to gain room while writing or while proofing. */
type ViewMode = "split" | "write" | "preview";

const MODES: { mode: ViewMode; icon: typeof CodeBracketIcon; labelKey: string }[] =
  [
    { mode: "split", icon: ViewColumnsIcon, labelKey: "editor.viewSplit" },
    { mode: "write", icon: CodeBracketIcon, labelKey: "editor.viewWrite" },
    { mode: "preview", icon: EyeIcon, labelKey: "editor.viewPreview" },
  ];

/**
 * Markdown editor: a plain textarea next to a live preview (ADR-0021 keeps this deliberately
 * lightweight — no TipTap/WYSIWYG). Controlled, so it drops into react-hook-form via a
 * `Controller`.
 *
 * A quiet segmented toggle (issue #310, ADR-0049) switches the pane between the side-by-side
 * split, a full-width source pane, and a full-width rendered preview — so the author can gain
 * horizontal room for either writing or proofing. Defaults to `split`. Mermaid fences and code
 * blocks render in the preview exactly as they do in the published article (same `MarkdownView`).
 *
 * When `wikiLink` is supplied, typing `[[` opens a slug autocomplete (ADR-0059 §3) so an author can
 * link an existing article without leaving the keyboard — ↑/↓ to move, Enter/Tab to insert `[[slug]]`,
 * Esc to dismiss.
 */
export function MarkdownEditor({
  value,
  onChange,
  id,
  placeholder,
  invalid,
  wikiLink,
}: MarkdownEditorProps) {
  const t = useTranslations("shared");
  const [mode, setMode] = useState<ViewMode>("split");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // The open `[[` token's query (null = the autocomplete is closed) and the highlighted suggestion.
  const [query, setQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const onQueryChange = wikiLink?.onQueryChange;
  const suggestions = wikiLink?.suggestions ?? [];
  const open = wikiLink != null && query !== null && suggestions.length > 0;

  const showSource = mode !== "preview";
  const showPreview = mode !== "write";

  /** Re-derive the open-`[[`-token query from the caret position after any value/caret change. */
  const syncQuery = useCallback(
    (text: string, caret: number) => {
      if (!wikiLink) return;
      const next = activeWikiLinkQuery(text, caret);
      setQuery(next);
      setActiveIndex(0);
      if (next !== null) onQueryChange?.(next);
    },
    [wikiLink, onQueryChange],
  );

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = event.target.value;
    onChange(text);
    syncQuery(text, event.target.selectionStart ?? text.length);
  };

  /** Insert the chosen slug as `[[slug]]`, replacing the open token, and close the popup. */
  const insertSuggestion = (slug: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const caret = textarea.selectionStart ?? value.length;
    const result = applyWikiLinkSuggestion(value, caret, slug);
    if (!result) return;
    onChange(result.value);
    setQuery(null);
    // Restore focus + caret after React re-renders the controlled value.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(result.caret, result.caret);
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => (i + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      insertSuggestion(suggestions[activeIndex].slug);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setQuery(null);
    }
  };

  const textarea = (
    <div className="relative">
      <Textarea
        ref={textareaRef}
        id={id}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        // Keep the open-token query in sync when the caret moves without an edit (arrow/click).
        onKeyUp={(e) =>
          syncQuery(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)
        }
        onClick={(e) =>
          syncQuery(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)
        }
        onBlur={() => setQuery(null)}
        placeholder={placeholder ?? t("editor.markdownPlaceholder")}
        aria-invalid={invalid || undefined}
        aria-expanded={open || undefined}
        aria-autocomplete={wikiLink ? "list" : undefined}
        spellCheck
        className="min-h-[420px] resize-y font-mono text-sm"
      />
      {open ? (
        <WikiLinkSuggestions
          suggestions={suggestions}
          activeIndex={activeIndex}
          onHover={setActiveIndex}
          onSelect={(slug) => insertSuggestion(slug)}
        />
      ) : null}
    </div>
  );

  const preview = (
    <div className="min-h-[420px] overflow-auto rounded-md border bg-muted/30 p-4">
      {value.trim() ? (
        <MarkdownView content={value} />
      ) : (
        <p className="text-sm text-muted-foreground">{t("editor.previewHint")}</p>
      )}
    </div>
  );

  return (
    <div className="space-y-3">
      {/* Quiet segmented control — ghost buttons on a muted track, the active one gets the
          card surface + ring. Restraint-consistent: no colour, glyph + label only. */}
      <div
        role="group"
        aria-label={t("editor.viewToggleLabel")}
        className="inline-flex items-center gap-0.5 rounded-lg border bg-muted/40 p-0.5"
      >
        {MODES.map(({ mode: m, icon: Icon, labelKey }) => {
          const active = mode === m;
          return (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-pressed={active}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] font-medium transition-all outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                active
                  ? "bg-card text-foreground shadow-e1 ring-1 ring-foreground/10"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-3.5" aria-hidden />
              {t(labelKey)}
            </button>
          );
        })}
      </div>

      <div
        className={cn(
          "grid gap-3",
          mode === "split" ? "md:grid-cols-2" : "grid-cols-1",
        )}
      >
        {showSource && textarea}
        {showPreview && preview}
      </div>
    </div>
  );
}
