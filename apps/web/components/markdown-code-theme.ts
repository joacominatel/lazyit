import type { CSSProperties } from "react";

/**
 * «Activated Restraint» code-highlight theme (ADR-0049, issue #200).
 *
 * A bespoke highlight.js token style for `react-syntax-highlighter` (Light/hljs build),
 * deliberately *not* a stock garish theme. Colour is ~5% of the pixels: every token sits
 * on one of three warm-bone tones so the block reads calm in both light and `.dark`.
 *
 *  - body / most tokens → `--foreground`        (15.5:1 light / 12.1:1 dark on `--muted`)
 *  - dim tokens (comments, meta, punctuation) → `--muted-foreground` (4.8:1 / 5.4:1)
 *  - the accent (keywords, types, built-ins, sections) → `--code-accent`, the single
 *    brand-indigo hue darkened/lightened per theme so it clears WCAG AA as token text on
 *    the `--muted` code surface (6.3:1 light / 5.7:1 dark). The raw `--chart-1` indigo
 *    fails AA there (~4.48 / ~3.60), so we never use it for token text — ADR-0049 §4.
 *
 * Because every value is a CSS variable, the *same* object is theme-correct under `.dark`
 * with no second palette and no `color-mix`/relative-colour (ADR-0049 keeps derived values
 * as precomputed token literals). The `hljs` base sets transparent — the surrounding `<pre>`
 * owns the `--muted` background so the look matches the old `prose-pre:bg-muted`.
 */
const accent: CSSProperties = { color: "var(--code-accent)" };
const base: CSSProperties = { color: "var(--foreground)" };
const dim: CSSProperties = { color: "var(--muted-foreground)" };

export const restraintCodeTheme: Record<string, CSSProperties> = {
  hljs: {
    display: "block",
    overflowX: "auto",
    background: "transparent",
    color: "var(--foreground)",
  },

  // Dim — secondary, non-semantic text.
  "hljs-comment": { ...dim, fontStyle: "italic" },
  "hljs-quote": { ...dim, fontStyle: "italic" },
  "hljs-meta": dim,
  "hljs-meta-string": dim,
  "hljs-doctag": dim,

  // Accent — the structural keywords/types that carry meaning.
  "hljs-keyword": accent,
  "hljs-selector-tag": accent,
  "hljs-literal": accent,
  "hljs-section": accent,
  "hljs-type": accent,
  "hljs-built_in": accent,
  "hljs-name": accent,
  "hljs-selector-id": accent,
  "hljs-selector-class": accent,
  "hljs-template-tag": accent,

  // Base — readable content tokens stay on the body tone; weight, not hue, separates them.
  "hljs-string": base,
  "hljs-regexp": base,
  "hljs-number": base,
  "hljs-symbol": base,
  "hljs-bullet": base,
  "hljs-link": { ...base, textDecoration: "underline" },
  "hljs-attr": base,
  "hljs-attribute": base,
  "hljs-variable": base,
  "hljs-template-variable": base,
  "hljs-title": { ...base, fontWeight: 600 },
  "hljs-class .hljs-title": { ...base, fontWeight: 600 },
  "hljs-selector-attr": base,
  "hljs-selector-pseudo": base,
  "hljs-params": base,
  "hljs-subst": base,
  "hljs-formula": base,
  "hljs-tag": base,

  // diff — keep the change semantics legible without leaning on red/green text (AA on
  // `--muted` would be fragile); weight + the dim/base split carries it.
  "hljs-addition": { ...base, fontWeight: 600 },
  "hljs-deletion": { ...dim, textDecoration: "line-through" },

  // Inline emphasis is expressed as style, never colour.
  "hljs-emphasis": { fontStyle: "italic" },
  "hljs-strong": { fontWeight: 700 },
};
