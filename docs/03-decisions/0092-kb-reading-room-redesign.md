---
title: "ADR-0092: The Reading Room — KB reading & browsing redesign"
tags: [adr, knowledge-base, kb, frontend, ux, markdown, search, information-architecture]
status: accepted
created: 2026-07-20
updated: 2026-07-20
deciders: [Joaquín Minatel]
---

# ADR-0092: The Reading Room — KB reading & browsing redesign

## Status

**accepted** — 2026-07-20 (issue [#1106](https://github.com/joacominatel/lazyit/issues/1106)). Shipped to
`dev` in four phases: PR #1107 (renderer), #1108 (reading view), #1109 (search + browse + tree), #1110
(write-side + counts + drag-drop). Frontend-led; one cross-layer add (a computed folder count). No
migration.

## Context

The Knowledge Base browse/read experience was, in the CEO's words, *incómoda — hard to understand,
impractical, bad UX*. A code recon confirmed concrete debt on the two KB surfaces:

- **Reading (`/kb/:slug`)**: no on-page table of contents, no heading anchors/deep-links; a
  metadata-dense header + narrow `max-w-3xl` + `prose-sm`; the excerpt as a competing blockquote; a
  **one-level breadcrumb** (you lose your place in the folder tree); and **four always-on stacked
  panels** (References / Aliases / Linked-to / Version-History) rendered even when empty.
- **Browse (`/kb`)**: the visible search box was the *weak* one (server title+excerpt filter), while the
  *strong* body full-text search hid inside the global ⌘K palette as 1 of 7 entity types; a low-density
  3-column card grid; a duplicate `FolderBrowseCard` drill-down grid that shipped a hardcoded
  `articleCount={0}` bug; unresolved `[[wiki-links]]` as dead-end tooltips.

A key structural insight: the reading renderer (`apps/web/components/markdown-view.tsx`) is **shared with
the public Manual** (`/help`, ADR-0062), so rendering-layer improvements lift both surfaces at once.

A creative panel explored four independent directions (an Obsidian knowledge-graph lens, a Notion
blocks-and-calm lens, a docs-as-product lens à la Stripe/Linear, and a lazyit-native/Ledger lens). Judges
converged on a **Notion × docs-product** spine, grafting the lazyit-native **"Covers `[asset] [app]`"
chips** (announce the runbook's subject) as the single best idea. The hard constraint from the CEO:
**BÁSICA** — simple and calm, *won as much by deletion as by addition*, not a feature-bloated IDE.

## Decision

Reinterpret the KB as **"The Reading Room"**: a reading-first surface where prose is the product and
orientation, relations, and history recede into rails and one honest search. Delivered in four
render-time phases (no data model change except one additive, computed count):

1. **Renderer glow-up (shared — also lifts the Manual).** `rehype-slug` heading ids + hover-`#`
   deep-link anchors; GitHub-style **callouts** (`> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]`, Ledger hues,
   **read-tolerant** so an unmarked blockquote is unchanged); an expanded IT code-grammar set; an
   inline-code chip; a table `overflow-x` wrapper; a native `<dialog>` image/mermaid **lightbox**;
   `prose-sm` → `prose`. Every pass sits in the **post-sanitize** slot, so the SEC-003 sanitize-first
   invariant holds and `SANITIZE_SCHEMA` never widens.
2. **The calm reading view.** Full folder-**path** breadcrumb; a slim **Ledger record header** (title +
   one mono/tabular-nums line: status **stamp** · version · author · updated); **"Covers" chips** under
   the title *only when the article links assets/apps*; the excerpt as a muted lede; the four panels
   **dissolved into one right-rail "Connections" block that renders a section only when non-empty**
   (Version History moves behind a ⋯ menu → the existing side Sheet); a sticky **"On this page" TOC**
   with `IntersectionObserver` scroll-spy; a prev/next sibling footer; hover **Quick View** on resolved
   `[[wiki-links]]`.
3. **Healed search + dense browse + persistent tree.** The visible box becomes the **strong Meili body
   search** (folder-access filtered) with `/`-to-focus and a KB-scoped ⌘K quick-switcher, degrading
   gracefully to the server title/excerpt filter when Meili is unavailable/unindexed; the card grid and
   the `FolderBrowseCard` grid are **deleted** in favor of a single **dense line-per-doc list**; advanced
   filters fold behind a **"Filters ▾"** popover; the folder tree is promoted into a **client
   route-shell** so it persists across `/kb` ↔ `/kb/:slug` with no remount/flash and highlights the
   reading article's home folder (the "lose your place" fix), server-seeded for cold deep-links.
4. **Write-side + counts.** Unresolved `[[wiki-links]]` become **"＋ Create this note"** for writers
   (readers keep the inert tooltip) → `/kb/new` prefilled with a sanitized slug/title; **real per-folder
   article counts** (a computed `_count`, folder-access-aware); and a **drag-and-drop `.md` import** on
   the New-article screen (native File API, no upload, type+size guarded, confirm-before-replace, a
   non-drag "Choose file" fallback).

**Deliberately NOT built** (the cleverness the *incómoda* complaint punishes): a knowledge/local graph,
a second (⌘O) command palette, per-heading section-folding, a tags taxonomy, and any inline/split/WYSIWYG
editor. Exactly **one net-new dependency** across the whole redesign: `rehype-slug`.

## Consequences

- **The Manual improves for free.** Phase 1's shared-renderer passes (anchors, callouts, code grammars,
  lightbox, prose size) are content-agnostic and left on for both KB and the public `/help` Manual; the
  KB-only passes (wiki-links, the Covers/Connections/TOC composition) stay gated behind
  `disableKbExtensions` / live in the KB page shell.
- **Upgrade-safe over production data (STANDING RULE).** The redesign is **render/composition-time only**.
  The single data-model touch is a `.nullish()` **computed** `articleCount` on the `ArticleCategory` read
  shape — no stored column, **no Prisma migration**, self-heals to hiding the number on an older API or a
  restricted folder. Full-text search depends on Meilisearch being reindexed (`reindex:all`) after an
  upgrade; the server title/excerpt filter remains a graceful degraded fallback so search never blank-
  screens in the meantime.
- **Authz preserved.** Folder-access rules (ADR-0060) and draft visibility bound both the search results
  and the per-folder counts — a count never reveals articles a viewer can't see. A create-on-click 409
  (slug already taken by a live-but-unseen row) surfaces a specific "name already exists" message rather
  than a generic error.
- **Known cosmetic (accepted):** on `xl`, a reader-facing article with *no headings and no connections*
  leaves the reserved right rail empty (whitespace, no visible panel). Rare (most articles have headings);
  deferred rather than refactor the rail-visibility gate up the tree.

## Alternatives considered

- **Redesign the KB and the Manual separately** — rejected: they share the renderer; one Phase-1 PR lifts
  both, and divergent chrome would double the work and the drift.
- **An Obsidian-style graph / second palette / section-folding** — rejected as anti-BÁSICA; the exact
  over-building the complaint reacted to.
- **Auto-suffix a colliding create-on-click slug** — rejected: a suffixed slug wouldn't resolve the
  original `[[link]]`, so it defeats the feature; a clear "name taken" message is the honest outcome.

Related: [[0062-public-manual]] · [[0077-ledger-design-system]] · [[0060-kb-folder-access-rules]] ·
[[0059-kb-wiki-links-and-backlinks]] · [[0035-meilisearch-search]] · [[0067-server-prefetch-hydration]] ·
[[article]] · [[article-category]] · [[article-wiki-link]]
