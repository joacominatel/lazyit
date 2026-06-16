---
title: Authoring the Help / Manual
tags: [development, web, frontend, docs, help, i18n]
status: draft
created: 2026-06-16
updated: 2026-06-16
---

# Authoring the Help / Manual

How to add and edit pages in the **Help / Manual** — lazyit's **public, login-free, shipped-with-the-code**
product documentation surface. Decision of record: [[0062-in-app-help-manual-surface]]. i18n model:
[[0051-i18n-next-intl]].

The Manual is **not** the Knowledge Base. The KB ([[0059-kb-folders-links-and-import]]) is operator-authored,
DB-backed, access-controlled content about *your estate*. The Manual is the product's own documentation about
*lazyit itself* — markdown in the repo, public, read-only in the app, versioned with the code. A typo fix is a
PR, not an in-app edit. See ADR-0062 for the full rationale.

> The page route, loader and switcher are the **scaffold** (#535). The real content (getting started,
> permissions, the Secret Manager, …) is tracked in **#536**. This doc is the convention; the placeholder
> `getting-started.md` only proves the pipeline.

## Where pages live

```
apps/web/content/manual/
  en/<slug>.md        # English (default + fallback)
  es/<slug>.md        # Spanish
```

- One markdown file = one Help page. The **file basename is the URL slug**: `en/getting-started.md` →
  `/help/getting-started`.
- Slugs must be **lowercase kebab-case** (`^[a-z0-9]+(?:-[a-z0-9]+)*$`) — letters, digits and single hyphens,
  one path segment, no nesting, no traversal. A file whose name breaks that rule is ignored by the loader.
- The route is **public** (`(marketing)` route group + a `/help` allowance in `apps/web/proxy.ts`'s
  `isPublicPath`). No auth, no permission, no ACL.

## Frontmatter schema

Each file opens with a **YAML frontmatter** block. Three fields are required; extra fields are allowed and
preserved (the parser is tolerant) but not interpreted by the surface.

```yaml
---
title: Getting started      # human title — shown in the nav index and as the page heading
order: 1                    # number — sort weight WITHIN the section (ascending)
section: Getting started    # the IA bucket this page belongs to (groups pages on /help)
---
```

| Field     | Type   | Required | Meaning |
| --------- | ------ | -------- | ------- |
| `title`   | string | yes      | The page title (nav + heading). Missing → falls back to the slug. |
| `order`   | number | yes      | Ascending sort **within** a section. Missing/non-numeric → sorts last. |
| `section` | string | yes      | The IA bucket (see below). Missing → a `General` catch-all bucket. |

The loader (`apps/web/lib/manual/loader.ts`) is **defensive**: a half-authored page with a missing field gets a
sensible default rather than crashing the render — but every shipped page should set all three explicitly.

## Sections / information architecture

The `/help` index groups pages **by their `section` value** into buckets, in this order:

- **Within a section:** ascending `order`, then alphabetical by `title`, then by `slug` (a stable, deterministic
  tiebreak).
- **Between sections:** by the smallest `order` of the pages each contains, then alphabetically by section name.
  So `order` is the single lever that drives both intra- and inter-section placement.

The seed IA (ADR-0062 §5) — fill these out in #536: **Getting started · Languages · Configuration · Services ·
Permissions · Best practices · Detailed explanations**. Keep `section` strings consistent across pages and
locales so buckets merge correctly.

## Navigation & search (issue #560)

Every Help route (`/help` AND `/help/<slug>`) is wrapped by a **persistent left sidebar** —
`apps/web/app/(marketing)/help/layout.tsx` (a Server Component) — that loads the page list once and renders the
nav beside the page content. The sidebar is **100% frontmatter-driven**: the same `section` → pages grouping the
index uses, sorted by `order`, with the **active page highlighted**. There is **nothing to register** — add a
page (per "How to add a Help page" below) and it appears in the sidebar automatically. On desktop (lg+) the rail
is always visible; on mobile it collapses into a "Browse" drawer (a shadcn `Sheet`). The sidebar/search
components live under `apps/web/app/(marketing)/help/_components/`.

At the top of the sidebar is a **simple, client-side search** box. It is deliberately **NOT Meilisearch** —
ADR-0062 §6 defers full-text search; this is a lightweight, in-memory filter with **no server call and no Meili
index**. The loader builds a small per-locale index at request time (`buildManualSearchIndex` →
`{ slug, title, section, headings[], excerpt }`, headings + a short plaintext excerpt extracted from the body)
and the client filters it as you type: **accent-insensitive** (so "configuracion" matches "configuración"),
substring, **title-first** ranking (title > section > heading > excerpt). The match/rank logic is the pure,
unit-tested `apps/web/lib/manual/search.ts` (`normalizeForSearch`, `searchManual`, plus the `extractHeadings` /
`buildExcerpt` index builders). What this means for authoring: a clear, distinctive **`title`**, a consistent
**`section`**, and descriptive **`#`/`##` headings** are what make a page findable — the same fields the IA
already rewards.

## i18n + the es→en fallback

- The active locale is the **`NEXT_LOCALE` cookie** (cookie-mode, no `/es/` URL prefix — [[0051-i18n-next-intl]]).
  The public language switcher in the `(marketing)` header lets a logged-out visitor flip en/es.
- **Fallback:** when a page is requested in `es` but `es/<slug>.md` is missing, the reader **falls back to
  `en/<slug>.md`** and shows a small "shown in English" notice. In development the loader also logs a
  `[manual] page "…" missing for locale "es"` warning. A fallback is a **documentation defect** — not an error,
  but something to close.
- A page that exists in **no** locale (neither the requested one nor `en`) is a **404** (`notFound()`).

## Parity rule (enforced)

The two locale trees **must stay in parity** — every slug present in one locale must exist in the other. This is
linted:

```sh
cd apps/web
bun run check:manual-parity     # exits 1 if any page lacks a counterpart in another locale
```

Run it before pushing Manual changes. It is wired as the `check:manual-parity` package script
(`apps/web/scripts/check-manual-parity.ts`). (CI wiring is a follow-up — see the script header.)

## How to add a Help page

1. Pick a kebab-case **slug** (e.g. `permissions`).
2. Create **both** locale files with full frontmatter:
   - `apps/web/content/manual/en/permissions.md`
   - `apps/web/content/manual/es/permissions.md`
3. Write plain product markdown. The Manual renders through the same `MarkdownView` the KB uses (GFM, code
   blocks, mermaid) **with `disableKbExtensions`** — so KB-only tokens (`[[slug]]` wiki-links and
   `{{ lazyit_secret.* }}` chips) render as **literal text**, never live elements. Link between Manual pages with
   ordinary relative links (`/help/<slug>`). **Never** reference a secret or a vault — the Manual is secret-free
   by construction ([[0062-in-app-help-manual-surface]] §3 / INV-10).
4. Run `bun run check:manual-parity` and confirm it passes.
5. The page appears automatically on `/help`, grouped by its `section` and sorted by `order` — both on the index
   and in the **sidebar** (issue #560) — and becomes searchable in the sidebar search. No registration, no index
   file to edit.

## Related

- [[0062-in-app-help-manual-surface]] — the decision (public, code-versioned, KB-distinct; §6 defers Meili search).
- [[0051-i18n-next-intl]] — cookie-mode i18n, en + es, default/fallback `en`.
- [[i18n]] — translating the rest of the chrome (message catalogs).
- `apps/web/components/markdown-view.tsx` — the renderer (`disableKbExtensions` prop).
- `apps/web/lib/manual/` — the loader (incl. `buildManualSearchIndex`) + the pure, tested resolve/sort/group and
  `search` (normalize/rank + heading/excerpt extraction) logic.
- `apps/web/app/(marketing)/help/layout.tsx` + `_components/` — the sidebar + simple client-side search (#560).
