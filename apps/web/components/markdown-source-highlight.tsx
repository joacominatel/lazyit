"use client";

import { Light as SyntaxHighlighter } from "react-syntax-highlighter";
import markdown from "react-syntax-highlighter/dist/esm/languages/hljs/markdown";
import { restraintMarkdownSourceTheme } from "@/components/markdown-source-theme";

/**
 * Live syntax colouring for the markdown **source** while it is being typed (issue #736).
 *
 * This is the highlighted layer of the write-mode overlay: a `<pre>` rendered *behind* a
 * transparent `<textarea>` in `MarkdownEditor`. The textarea owns all interaction (caret,
 * selection, scroll, IME, undo, the `[[`/`{{` autocompletes); this layer only paints colour, so
 * ADR-0021's lightweight-editor stance holds — we never replaced the textarea with a code-editor
 * surface (no CodeMirror, no `react-simple-code-editor`).
 *
 * Highlighting reuses the already-installed `react-syntax-highlighter` Light/hljs build with the
 * `markdown` grammar — **no new dependency** — and the `restraintMarkdownSourceTheme` token palette
 * (headings → accent, bold/italic → weight/style, links/code/quotes → calm tones). The `[[` / `{{`
 * reserved tokens are post-painted by `MarkdownEditor` on top of this.
 *
 * Alignment is the whole game: every typographic box-model property here must match the textarea
 * 1:1 (font, size, line-height, padding, `white-space`, `word-break`) so a glyph in the `<pre>`
 * sits exactly under the same glyph in the textarea. Those shared properties live in
 * `MARKDOWN_SOURCE_BOX` so both layers stay in lockstep.
 *
 * SECURITY: this only colours the literal source string the author typed. It resolves nothing — a
 * `{{ lazyit_secret.handle }}` shows the handle text, never a value (INV-10) — and it is rendered
 * by React after no sanitisation step, identical to the preview highlighter (SEC-003 untouched: the
 * sanitiser never sees these spans because they are not part of the stored/rendered article HTML).
 */

SyntaxHighlighter.registerLanguage("markdown", markdown);

/**
 * The typographic box shared by the highlighted `<pre>` and the transparent `<textarea>`. Both
 * layers MUST carry these exact classes or the colour drifts off the glyphs. Kept as one constant
 * so a change to padding/leading/wrap can never desync the two surfaces.
 *
 *  - `font-mono text-sm` — same family + size as the original editor textarea.
 *  - `leading-relaxed` — an explicit line-height so wrapped lines line up (textarea default leading
 *    is UA-dependent; pinning it removes the drift).
 *  - `px-2.5 py-2` — matches the shadcn `Textarea` padding so column 0 starts at the same x.
 *  - `whitespace-pre-wrap break-words` — the textarea wraps long lines and preserves runs of
 *    spaces/newlines; the `<pre>` must wrap identically (not `pre` / not `nowrap`).
 */
export const MARKDOWN_SOURCE_BOX =
  "px-2.5 py-2 font-mono text-sm leading-relaxed whitespace-pre-wrap break-words";

/**
 * The highlighted source layer. `value` is the full markdown source; it is painted into a `<pre>`
 * (`PreTag`/`CodeTag` = plain `div`s so this component owns the box model — no nested margins from
 * the highlighter's default `<pre>`). A trailing newline is appended so a final empty line still
 * reserves a row, keeping the last textarea line aligned. `aria-hidden` because the textarea is the
 * accessible control; this layer is decorative.
 */
export function MarkdownSourceHighlight({ value }: { value: string }) {
  return (
    <SyntaxHighlighter
      language="markdown"
      style={restraintMarkdownSourceTheme}
      PreTag="div"
      CodeTag="div"
      // The colour layer must not capture pointer/selection events — the textarea on top owns them.
      aria-hidden
      className={`pointer-events-none ${MARKDOWN_SOURCE_BOX}`}
      customStyle={{
        margin: 0,
        background: "transparent",
        // Inherit the box typography from the className so the two layers cannot diverge.
        fontSize: "inherit",
        lineHeight: "inherit",
        fontFamily: "inherit",
        padding: 0,
      }}
      codeTagProps={{ style: { fontFamily: "inherit" } }}
    >
      {/* Trailing newline keeps the final (possibly empty) line height-reserved, matching the
          textarea's own trailing-line behaviour so scroll/caret stay aligned at the very bottom. */}
      {value + "\n"}
    </SyntaxHighlighter>
  );
}
