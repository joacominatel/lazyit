import type { CSSProperties } from "react";

/**
 * Token palette for the **write-mode markdown source** overlay (issue #736) — the colours painted
 * under the transparent textarea so the raw source reads as structured while you type, VSCode-style.
 *
 * This is a sibling of `restraintCodeTheme` (which styles *fenced code* in the rendered preview),
 * but tuned for the markdown grammar's own token set (`section`, `strong`, `emphasis`, `link`,
 * `bullet`, `code`, `quote`, `string`, `symbol`). It follows ADR-0049 «Activated Restraint».
 *
 * METRIC PARITY (issue #796): this is a **colour-only** theme — it sets *only* `color`. The overlay
 * is a coloured `<pre>` painted *under* a transparent `<textarea>` whose own glyphs are always the
 * editor's regular weight/style/size. Any token property that changes a glyph's advance width
 * (`font-weight`, `font-style: italic`, `font-size`, `letter-spacing`) would make a bold/italic run
 * in the `<pre>` wider or narrower than the same run in the textarea, so the two layers drift and the
 * caret separates from the visible text. We therefore differentiate purely by hue/tone:
 *
 *  - **Headings** (`## Title` → `hljs-section`) get the single brand accent — the legibility win the
 *    original issue asked for ("# ADR-0011" reads blue), now colour-only (no bold).
 *  - **Bold / italic** (`hljs-strong` / `hljs-emphasis`) read as the accent too: "emphasised text =
 *    coloured", never weight or slant — so the calm source still flags what will stand out rendered.
 *  - **Links, code spans, lists, blockquotes** sit on the dim tone so structure is visible without
 *    turning the editor into a rainbow.
 *
 * Every value is a CSS variable, so the same object is theme-correct under `.dark` with no second
 * palette. `--code-accent` is the AA-safe brand indigo already used by the preview highlighter.
 *
 * The base `hljs` colour is left at `--foreground` so any *unhighlighted* run of source text (plain
 * paragraphs, the bulk of an article) renders in the normal editor colour — only the markers and
 * headings pick up colour.
 */
const accent: CSSProperties = { color: "var(--code-accent)" };
const dim: CSSProperties = { color: "var(--muted-foreground)" };

export const restraintMarkdownSourceTheme: Record<string, CSSProperties> = {
  hljs: {
    display: "block",
    background: "transparent",
    color: "var(--foreground)",
  },

  // Headings — the accent. `## Status` reads instantly as a heading on hue alone (no weight change,
  // which would widen the glyphs and drift the overlay off the caret — see METRIC PARITY above).
  "hljs-section": accent,

  // Emphasis — the accent, expressed as colour (never weight/italic, which alter glyph advance).
  "hljs-strong": accent,
  "hljs-emphasis": accent,

  // Structure tokens — visible but quiet, on the dim tone.
  "hljs-bullet": dim, // list markers (-, *, 1.)
  "hljs-quote": dim, // > blockquotes (dim only — no italic, which would change glyph metrics)
  "hljs-code": dim, // `inline code` and ``` fences
  "hljs-link": dim, // [text](url) and bare links
  "hljs-symbol": dim, // link reference symbols
  "hljs-string": dim, // link URLs
};
