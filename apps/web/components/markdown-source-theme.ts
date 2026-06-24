import type { CSSProperties } from "react";

/**
 * Token palette for the **write-mode markdown source** overlay (issue #736) — the colours painted
 * under the transparent textarea so the raw source reads as structured while you type, VSCode-style.
 *
 * This is a sibling of `restraintCodeTheme` (which styles *fenced code* in the rendered preview),
 * but tuned for the markdown grammar's own token set (`section`, `strong`, `emphasis`, `link`,
 * `bullet`, `code`, `quote`, `string`, `symbol`). It follows ADR-0049 «Activated Restraint»:
 *
 *  - **Headings** (`## Title` → `hljs-section`) get the single brand accent + bold, the one piece of
 *    real colour — this is the legibility win the issue asks for ("# ADR-0011" reads blue + bold).
 *  - **Bold / italic** markers express themselves as weight/style, not hue — the source stays calm.
 *  - **Links, code spans, lists, blockquotes** sit on the dim tone so structure is visible without
 *    turning the editor into a rainbow.
 *
 * Every value is a CSS variable, so the same object is theme-correct under `.dark` with no second
 * palette. `--code-accent` is the AA-safe brand indigo already used by the preview highlighter.
 *
 * The base `hljs` colour is left at `--foreground` so any *unhighlighted* run of source text (plain
 * paragraphs, the bulk of an article) renders in the normal editor colour — only the markers and
 * headings pick up styling.
 */
const accent: CSSProperties = { color: "var(--code-accent)" };
const dim: CSSProperties = { color: "var(--muted-foreground)" };

export const restraintMarkdownSourceTheme: Record<string, CSSProperties> = {
  hljs: {
    display: "block",
    background: "transparent",
    color: "var(--foreground)",
  },

  // Headings — the accent + weight. `## Status` should read instantly as a heading.
  "hljs-section": { ...accent, fontWeight: 700 },

  // Emphasis markers — style, never colour (matches the rendered look: bold is bold, italic italic).
  "hljs-strong": { fontWeight: 700 },
  "hljs-emphasis": { fontStyle: "italic" },

  // Structure tokens — visible but quiet, on the dim tone.
  "hljs-bullet": dim, // list markers (-, *, 1.)
  "hljs-quote": { ...dim, fontStyle: "italic" }, // > blockquotes
  "hljs-code": dim, // `inline code` and ``` fences
  "hljs-link": dim, // [text](url) and bare links
  "hljs-symbol": dim, // link reference symbols
  "hljs-string": dim, // link URLs
};
