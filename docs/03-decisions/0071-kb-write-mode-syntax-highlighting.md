---
title: "ADR-0071: KB write-mode syntax highlighting — overlay over the textarea, not a code-editor replatform"
tags: [adr, knowledge-base, kb, editor, frontend]
status: superseded
created: 2026-06-24
updated: 2026-06-24
deciders: [Joaquín Minatel]
---

# ADR-0071: KB write-mode syntax highlighting — overlay over the textarea

## Status

> **Superseded — 2026-06-24 (issue #803).** The overlay was reverted: in practice the write pane kept
> showing caret/glyph drift even after the color-only fix (#796), and the legibility-only payoff did not
> justify the fragile transparent-textarea-over-`<pre>` metric parity. The KB editor is back to a plain
> visible-text `<textarea>` (ADR-0021 fully intact). **The `[[` / `{{` autocompletes and the caret-aware
> popup placement (#797) were retained** — only the colouring layer (`markdown-source-highlight.tsx`,
> `markdown-source-theme.ts`) was removed. A future code-editor surface, if ever wanted, would be its own
> epic + ADR.

**accepted** — 2026-06-24. Built for issue #736. Extends — does **not** supersede —
[[0021-knowledge-base-design]] (the deliberately lightweight `<textarea>` + live-preview editor) and
sits alongside [[0049-activated-restraint-ux-direction]] (the «Activated Restraint» token palette this
reuses), [[0059-kb-folders-links-and-import]] §3 (the `[[slug]]` wiki-link autocomplete) and
ADR-0061 §8 (the `{{ lazyit_secret.HANDLE }}` chip autocomplete) — both of which keep working unchanged.

## Context

The KB markdown editor (`apps/web/components/markdown-editor.tsx`) is a plain `<textarea>` with a
live-preview pane and a write/split/preview toggle. ADR-0021 chose this on purpose: no TipTap, no
WYSIWYG, no heavy code-editor — boring, durable, controlled, drops straight into react-hook-form.

Issue #736 asks for **VSCode/Obsidian-style inline syntax colouring of the source while typing** —
headings bold + coloured, emphasis/lists/code/links tinted, the `[[`/`{{` reserved tokens legible —
so the raw markdown reads as structured without flipping to preview. A `<textarea>` cannot colour its
own content.

Two constraints make this non-trivial:

1. Two bespoke autocompletes (`[[` wiki-links, `{{` secret chips) attach to the textarea and depend on
   its native caret/selection (`selectionStart`, `setSelectionRange`, `focus`) and on their popups
   being absolutely positioned inside the editor's `.relative` container. They **must** keep working
   byte-for-byte.
2. The preview pane and the `rehype-sanitize` pipeline (SEC-003) must not be touched, and a secret
   reference must never resolve a value in the editor (INV-10) — only the handle text is shown.

## Considered options

- **Replatform to CodeMirror 6** (markdown mode + decorations hosting the two pickers). Purpose-built,
  but it **reverses ADR-0021** — it replaces the textarea with a code-editor surface, re-homes the
  autocompletes onto CodeMirror's autocomplete API, and pulls the heavy editor ADR-0021 rejected. A
  whole epic + its own ADR. The CEO explicitly did **not** pick this. ❌
- **`react-simple-code-editor`** (tiny textarea + highlighted `<pre>`). Closer in spirit, but its
  `ref` exposes only `{ session }` — **not** the underlying `<textarea>` — and it owns `keydown` (tab
  handling) plus a **custom undo stack**. Both collide with the caret-dependent autocompletes and the
  native undo the textarea gives us today. Adds a dependency for no net win over hand-rolling. ❌
- **A hand-rolled overlay: keep the exact `<textarea>` (transparent text, visible caret) layered over a
  scroll-synced highlighted `<pre>`.** The textarea stays the one interactive surface — caret,
  selection, scroll, IME, undo, and both autocompletes are untouched **by construction** (not a single
  line of their wiring changes). The `<pre>` is a `pointer-events-none`, `aria-hidden`, `z`-below,
  decorative colour layer. Highlighting reuses the **already-installed** `react-syntax-highlighter`
  Light/hljs build with its `markdown` grammar — **zero new dependencies**. ✅ *(chosen)*

The hand-rolled overlay is the "classic 3am-pager" only when you fight caret/scroll/IME sync. We dodge
all of that: the textarea remains the source of truth for every interaction; the overlay merely mirrors
its scroll offset and shares an identical typographic box so the colour sits on the glyphs.

## Decision

- **Keep the `<textarea>`** (ADR-0021 intact). Add a highlighted `<pre>` layer **behind** it; make the
  textarea's text transparent (`text-transparent`) with a visible caret (`caret-foreground`).
- **Shared typographic box** (`MARKDOWN_SOURCE_BOX`) — font, size, line-height, padding,
  `whitespace-pre-wrap`, `break-words` — applied identically to both layers so a glyph in the textarea
  sits exactly over its coloured twin. The textarea overrides the shadcn `field-sizing-content` with
  `field-sizing-fixed` so its own scroll drives a scrollbar that `onScroll` mirrors onto the layer.
- **Highlighter:** `react-syntax-highlighter` Light build + `hljs/markdown` grammar (same import shape
  as the preview's `code-highlighter.tsx`), painted with a new `restraintMarkdownSourceTheme` —
  headings → `--code-accent`, bold/italic → weight/style, lists/code/links/quotes → the dim tone. No
  new dependency; CSS-variable values stay theme-correct under `.dark`.
- **Autocompletes unchanged.** The `[[`/`{{` token detection, insertion-at-caret, key handling, and
  popups are not modified. The popups still render in the same `.relative` container, `z`-above both
  the textarea and the colour layer.
- **Same prop contract.** `MarkdownEditor` keeps `value/onChange/id/placeholder/invalid/wikiLink/secretChip`
  — `/kb/new` and `/kb/[slug]/edit` are unaffected. The write/split/preview toggle, invalid state,
  placeholder, label/aria and focus are preserved.

## Consequences

- **+** The write pane reads as structured source while typing; no replatform, no behaviour change to
  the autocompletes, the preview, or the sanitiser; zero new dependencies.
- **+** ADR-0021's lightweight-editor stance survives — the editor is still a textarea.
- **−** Two surfaces must keep identical typography; a future change to padding/leading on one must
  change both. The shared `MARKDOWN_SOURCE_BOX` constant is the guardrail (a desync shows as colour
  drifting off the glyphs).
- **−** **Metric parity — the overlay theme must be colour-only** (issue #796). Because the transparent
  textarea on top is always the editor's regular weight/style/size, any token style that changes a
  glyph's advance width — `font-weight`, `font-style: italic`, `font-size`, `letter-spacing` — makes
  that run wider/narrower in the coloured `<pre>` than in the textarea, so the layers drift and the
  **caret separates from the visible text** (it showed on `## heading` lines, bold via `**…**`, and the
  italicised `_secret` in `{{ lazyit_secret.… }}`). `restraintMarkdownSourceTheme` is therefore
  restricted to `color` (plus the base `hljs` `display`/`background`): headings + bold + italic
  differentiate by the brand accent **hue**, blockquotes by the dim tone — never by weight or slant.
  This is also an a11y win: emphasis is conveyed by both the source colour *and* the live preview, not
  by a font style that some users can't perceive in a monospace editor.
- **−** The source highlighter is hljs's markdown grammar, not a markdown-it-faithful tokenizer — it is
  a *legibility* aid, not a parser. The preview remains the source of truth for how markdown renders.
- **+** **Caret-aware autocomplete popups** (issue #797). The `[[` / `{{` suggestion popups were pinned
  to the editor's top-left, covering the lines being typed. They now anchor just *below the caret's
  line* (flipping above when near the bottom), measured with a self-cleaning hidden-mirror-`<div>`
  helper (`apps/web/lib/utils/textarea-caret.ts`). Keyboard nav, selection, and the token detection /
  insertion helpers are unchanged. The pure clamp/flip layout is unit-tested (`textarea-caret.test.ts`).
- Files: `apps/web/components/markdown-editor.tsx` (overlay wiring + caret-aware popup placement),
  `apps/web/components/markdown-source-highlight.tsx` (the layer + shared box),
  `apps/web/components/markdown-source-theme.ts` (the colour-only token palette),
  `apps/web/components/markdown-{wiki-link,secret-chip}-autocomplete.tsx` (popup accepts a caret `style`),
  `apps/web/lib/utils/textarea-caret.ts` (+ `.test.ts`, the caret-rect / placement helper).
  Manual: KB authoring page (en+es).
