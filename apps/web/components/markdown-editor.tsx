"use client";

import {
  CodeBracketIcon,
  EyeIcon,
  PhotoIcon,
  ViewColumnsIcon,
} from "@heroicons/react/24/outline";
import type { Attachment } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownView } from "@/components/markdown-view";
import { ArticleAttachmentProvider } from "@/components/markdown-attachment-image-view";
import { notifyError } from "@/lib/api/notify-error";
import { toast } from "sonner";
import { MarkdownSyntaxHelp } from "@/components/markdown-syntax-help";
import {
  type WikiLinkAutocomplete,
  WikiLinkSuggestions,
  activeWikiLinkQuery,
  applyWikiLinkSuggestion,
} from "@/components/markdown-wiki-link-autocomplete";
import {
  type SecretChipAutocomplete,
  SecretChipSuggestions,
  activeSecretChipQuery,
  applySecretChipSuggestion,
} from "@/components/markdown-secret-chip-autocomplete";
import { cn } from "@/lib/utils";
import {
  type PopupPosition,
  caretPopupPosition,
} from "@/lib/utils/textarea-caret";

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
  /**
   * Optional `{{ lazyit_secret.HANDLE }}` chip autocomplete (ADR-0061 §8). When provided, typing
   * `{{ lazyit_secret.` inside the source pane opens a handle picker fed by `suggestions` (the
   * caller fetches them via `useHandleSuggestions` — HANDLES only, never values); `onQueryChange`
   * is called with the partial handle text so the caller can drive that search. Selecting a
   * suggestion inserts `{{ lazyit_secret.HANDLE }}`. Omit for a plain editor without chip support.
   */
  secretChip?: SecretChipAutocomplete;
  /**
   * Optional KB inline-image upload (ADR-0082 §5). When present, pasting or dropping an image into
   * the source pane — or using the toolbar image button — uploads it and inserts an
   * `![name](attachment:<id>)` ref at the caret (Marta's paste-from-clipboard flow). `articleId` is
   * the saved article's id: it drives real uploads AND the live-preview image provider. On a
   * not-yet-saved draft (`/kb/new`) `upload` is omitted, so a paste shows a "save the draft first"
   * hint instead of silently failing. Omit the whole prop for a plain editor without image support.
   */
  image?: {
    articleId?: string;
    upload?: (file: File) => Promise<Attachment>;
  };
}

/** Collect image files from a paste/drop DataTransfer (type `image/*`). Empty → not an image event. */
function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  return Array.from(data.files).filter((file) => file.type.startsWith("image/"));
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
 * The two source-pane autocompletes grouped into one machine: each picker's open-token query +
 * highlighted suggestion index, plus the shared caret-anchored popup position (only one popup is
 * active at a time — wiki takes priority over chip).
 */
type AutocompleteState = {
  wikiQuery: string | null;
  wikiActiveIndex: number;
  chipQuery: string | null;
  chipActiveIndex: number;
  popupPos: PopupPosition | null;
};

type AutocompleteAction =
  | { type: "wikiQuerySynced"; query: string | null }
  | { type: "wikiClosed" }
  | { type: "wikiActiveIndexSet"; index: number }
  | { type: "wikiActiveIndexMoved"; delta: number; length: number }
  | { type: "chipQuerySynced"; query: string | null }
  | { type: "chipClosed" }
  | { type: "chipActiveIndexSet"; index: number }
  | { type: "chipActiveIndexMoved"; delta: number; length: number }
  | { type: "popupPositioned"; pos: PopupPosition | null };

const INITIAL_AUTOCOMPLETE: AutocompleteState = {
  wikiQuery: null,
  wikiActiveIndex: 0,
  chipQuery: null,
  chipActiveIndex: 0,
  popupPos: null,
};

function autocompleteReducer(
  state: AutocompleteState,
  action: AutocompleteAction,
): AutocompleteState {
  switch (action.type) {
    case "wikiQuerySynced":
      // A fresh query resets the highlighted index (mirrors setWikiActiveIndex(0)).
      return { ...state, wikiQuery: action.query, wikiActiveIndex: 0 };
    case "wikiClosed":
      return { ...state, wikiQuery: null };
    case "wikiActiveIndexSet":
      return { ...state, wikiActiveIndex: action.index };
    case "wikiActiveIndexMoved":
      // Faithful translation of the functional ±1 wrap-around update.
      return {
        ...state,
        wikiActiveIndex:
          (state.wikiActiveIndex + action.delta + action.length) %
          action.length,
      };
    case "chipQuerySynced":
      return { ...state, chipQuery: action.query, chipActiveIndex: 0 };
    case "chipClosed":
      return { ...state, chipQuery: null };
    case "chipActiveIndexSet":
      return { ...state, chipActiveIndex: action.index };
    case "chipActiveIndexMoved":
      return {
        ...state,
        chipActiveIndex:
          (state.chipActiveIndex + action.delta + action.length) %
          action.length,
      };
    case "popupPositioned":
      return { ...state, popupPos: action.pos };
  }
}

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
  secretChip,
  image,
}: MarkdownEditorProps) {
  const t = useTranslations("shared");
  const ti = useTranslations("attachments");
  const [mode, setMode] = useState<ViewMode>("split");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Latest value for the async upload callbacks: the closed-over `value` is stale by the time an
  // upload resolves (the author kept typing), so token→ref replacement reads/writes through this ref.
  // Synced from the prop via an effect (never assigned during render); `uploadImages` also writes it
  // directly inside its event handler so a same-tick replace reads the value it just inserted.
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  // Wiki-link + secret-chip autocomplete state grouped into one machine — see `autocompleteReducer`.
  // Includes the caret-aware popup placement (issue #797): the `{ top, left }` for whichever picker is
  // open, re-measured from the caret on every query sync; `null` falls back to a static anchor.
  const [ac, dispatch] = useReducer(autocompleteReducer, INITIAL_AUTOCOMPLETE);

  const wikiOnQueryChange = wikiLink?.onQueryChange;
  const wikiSuggestions = wikiLink?.suggestions ?? [];
  const wikiOpen =
    wikiLink != null && ac.wikiQuery !== null && wikiSuggestions.length > 0;

  const chipOnQueryChange = secretChip?.onQueryChange;
  const chipSuggestions = secretChip?.suggestions ?? [];
  const chipOpen =
    secretChip != null && ac.chipQuery !== null && chipSuggestions.length > 0;

  // Only one popup is active at a time (wikiOpen takes priority; chipOpen is checked second).
  const anyOpen = wikiOpen || chipOpen;

  const showSource = mode !== "preview";
  const showPreview = mode !== "write";

  /** Re-derive both autocomplete queries from the caret position after any value/caret change. */
  const syncQuery = useCallback(
    (text: string, caret: number) => {
      // Wiki-link query.
      let open = false;
      // The popup's CSS box caps so the clamp keeps it on-screen before it renders (see the
      // `w-72`/`w-80` + `max-h-64` classes on the two pickers).
      let popupWidth = 0;
      if (wikiLink) {
        const next = activeWikiLinkQuery(text, caret);
        dispatch({ type: "wikiQuerySynced", query: next });
        if (next !== null) {
          wikiOnQueryChange?.(next);
          open = true;
          popupWidth = 288; // w-72
        }
      }
      // Secret chip query (only anchors the popup if a wiki token didn't already claim it).
      if (secretChip) {
        const next = activeSecretChipQuery(text, caret);
        dispatch({ type: "chipQuerySynced", query: next });
        if (next !== null) {
          chipOnQueryChange?.(next);
          if (!open) {
            open = true;
            popupWidth = 320; // w-80
          }
        }
      }
      // Anchor the open picker just below the caret line; keep the last position while none is open.
      if (open && textareaRef.current) {
        dispatch({
          type: "popupPositioned",
          pos: caretPopupPosition(textareaRef.current, caret, {
            width: popupWidth,
            height: 256, // max-h-64
          }),
        });
      }
    },
    [wikiLink, wikiOnQueryChange, secretChip, chipOnQueryChange],
  );

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = event.target.value;
    onChange(text);
    syncQuery(text, event.target.selectionStart ?? text.length);
  };

  /** Insert the chosen wiki-link slug as `[[slug]]`, replacing the open token. */
  const insertWikiSuggestion = (slug: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const caret = textarea.selectionStart ?? value.length;
    const result = applyWikiLinkSuggestion(value, caret, slug);
    if (!result) return;
    onChange(result.value);
    dispatch({ type: "wikiClosed" });
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(result.caret, result.caret);
    });
  };

  /** Insert the chosen secret chip as `{{ lazyit_secret.HANDLE }}`, replacing the open token. */
  const insertChipSuggestion = (handle: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const caret = textarea.selectionStart ?? value.length;
    const result = applySecretChipSuggestion(value, caret, handle);
    if (!result) return;
    onChange(result.value);
    dispatch({ type: "chipClosed" });
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(result.caret, result.caret);
    });
  };

  /**
   * Upload each pasted/dropped/picked image and swap an inserted placeholder for its
   * `![name](attachment:<id>)` ref (ADR-0082 §5). The placeholder (a plain-text `![uploading …]()`
   * token with a nonce so concurrent uploads never collide) is visible in the source pane while the
   * blob uploads; on success it becomes the real ref, on failure it's removed and the error toasted.
   * When `image.upload` is absent (a not-yet-saved draft) we surface the "save first" hint instead.
   */
  const uploadImages = (files: File[]) => {
    if (!image?.upload) {
      toast.error(ti("paste.saveFirst"));
      return;
    }
    const upload = image.upload;
    for (const file of files) {
      const nonce = Math.random().toString(36).slice(2, 8);
      const placeholder = `![${ti("paste.uploadingAlt", { name: file.name })}](uploading:${nonce})`;
      // Insert the placeholder at the caret (or append when the textarea isn't focused).
      const el = textareaRef.current;
      const caret = el?.selectionStart ?? valueRef.current.length;
      const before = valueRef.current.slice(0, caret);
      const after = valueRef.current.slice(caret);
      const next = `${before}${placeholder}${after}`;
      valueRef.current = next;
      onChange(next);
      upload(file)
        .then((attachment) => {
          const ref = `![${attachment.originalName}](attachment:${attachment.id})`;
          const swapped = valueRef.current.replace(placeholder, ref);
          valueRef.current = swapped;
          onChange(swapped);
        })
        .catch((error) => {
          const removed = valueRef.current.replace(placeholder, "");
          valueRef.current = removed;
          onChange(removed);
          notifyError(error, ti("paste.uploadError"));
        });
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!image) return; // no image support → default text paste
    const files = imageFilesFrom(event.clipboardData);
    if (files.length === 0) return; // not an image → let the default paste through
    event.preventDefault();
    uploadImages(files);
  };

  const handleDrop = (event: DragEvent<HTMLTextAreaElement>) => {
    if (!image) return;
    const files = imageFilesFrom(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    uploadImages(files);
  };

  const handleDragOver = (event: DragEvent<HTMLTextAreaElement>) => {
    // `dataTransfer.files` is empty during dragover (only populated on drop), so gate on `types`
    // instead — claim only file drags so text/URL drags keep their normal behavior.
    if (image && event.dataTransfer.types.includes("Files")) event.preventDefault();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!anyOpen) return;
    // Wiki-link popup takes priority when both are somehow open simultaneously.
    if (wikiOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        dispatch({
          type: "wikiActiveIndexMoved",
          delta: 1,
          length: wikiSuggestions.length,
        });
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        dispatch({
          type: "wikiActiveIndexMoved",
          delta: -1,
          length: wikiSuggestions.length,
        });
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        insertWikiSuggestion(wikiSuggestions[ac.wikiActiveIndex].slug);
      } else if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "wikiClosed" });
      }
      return;
    }
    if (chipOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        dispatch({
          type: "chipActiveIndexMoved",
          delta: 1,
          length: chipSuggestions.length,
        });
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        dispatch({
          type: "chipActiveIndexMoved",
          delta: -1,
          length: chipSuggestions.length,
        });
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        insertChipSuggestion(chipSuggestions[ac.chipActiveIndex].handle);
      } else if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "chipClosed" });
      }
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
        onPaste={image ? handlePaste : undefined}
        onDrop={image ? handleDrop : undefined}
        onDragOver={image ? handleDragOver : undefined}
        // Keep the open-token queries in sync when the caret moves without an edit (arrow/click).
        onKeyUp={(e) =>
          syncQuery(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)
        }
        onClick={(e) =>
          syncQuery(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)
        }
        onBlur={() => {
          dispatch({ type: "wikiClosed" });
          dispatch({ type: "chipClosed" });
        }}
        placeholder={placeholder ?? t("editor.markdownPlaceholder")}
        aria-invalid={invalid || undefined}
        aria-expanded={anyOpen || undefined}
        aria-autocomplete={wikiLink || secretChip ? "list" : undefined}
        spellCheck
        className="min-h-[420px] resize-y font-mono text-sm"
      />
      {wikiOpen ? (
        <WikiLinkSuggestions
          suggestions={wikiSuggestions}
          activeIndex={ac.wikiActiveIndex}
          onHover={(index) => dispatch({ type: "wikiActiveIndexSet", index })}
          onSelect={(slug) => insertWikiSuggestion(slug)}
          style={ac.popupPos ?? undefined}
        />
      ) : chipOpen ? (
        <SecretChipSuggestions
          suggestions={chipSuggestions}
          activeIndex={ac.chipActiveIndex}
          onHover={(index) => dispatch({ type: "chipActiveIndexSet", index })}
          onSelect={(handle) => insertChipSuggestion(handle)}
          style={ac.popupPos ?? undefined}
        />
      ) : null}
    </div>
  );

  // The preview resolves `attachment:<id>` images against the saved article (ADR-0082 §5). On a
  // not-yet-saved draft there's no id, so images fall back to the provider-less placeholder.
  const rendered = value.trim() ? <MarkdownView content={value} /> : null;
  const preview = (
    <div className="min-h-[420px] overflow-auto rounded-md border bg-muted/30 p-4">
      {rendered ? (
        image?.articleId ? (
          <ArticleAttachmentProvider articleId={image.articleId}>
            {rendered}
          </ArticleAttachmentProvider>
        ) : (
          rendered
        )
      ) : (
        <p className="text-sm text-muted-foreground">{t("editor.previewHint")}</p>
      )}
    </div>
  );

  return (
    <div className="space-y-3">
      {/* Toolbar row: the layout toggle on the left, the reserved-syntax `?` helper (issue #720)
          on the right. Lives here so both the `/kb/new` and edit routes get it via the one editor. */}
      <div className="flex items-center justify-between gap-2">
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

        <div className="flex items-center gap-1">
          {/* Keyboard-accessible upload (the ADR's secondary path beside paste/drag-drop). Hidden
              only when the editor has no image support at all. */}
          {image ? (
            <>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[0.8rem] font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <PhotoIcon className="size-3.5" aria-hidden />
                {ti("paste.insertImage")}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                className="sr-only"
                aria-label={ti("paste.insertImage")}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length > 0) uploadImages(files);
                  e.target.value = ""; // allow re-picking the same file
                }}
              />
            </>
          ) : null}
          <MarkdownSyntaxHelp />
        </div>
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
