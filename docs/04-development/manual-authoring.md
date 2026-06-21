---
title: Authoring the Help / Manual
tags: [development, web, frontend, docs, help, i18n]
status: active
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

The surface is **live**: the route/loader/sidebar/search scaffold (#535/#560), the nested IA (#563), and
the full ratified content — the 13 categories of ADR-0062 §5, en + es (#564) — are all shipped.

## When to update the Manual (the rule)

**Any user-facing change or addition updates the Manual in the same change.** New feature, changed
behavior, renamed setting, new screen → the matching Manual page must be created or edited (en + es)
as part of that work, not later. A user-facing change isn't *done* until its Manual page is — the same
discipline as keeping `docs/` in sync ([[claude-workflow]] §5, and `CLAUDE.md` "How we work" #7). If
you're unsure which page, find the category/subcategory in `_nav.ts`; if the topic is genuinely new,
add the page (and, if needed, the manifest key + i18n label) per "How to add a Help page" below.

What does **not** need a Manual update: internal refactors, dev-tooling, tests, infra/CI, or anything
an operator never sees. When in doubt, ask: *would a person using lazyit notice this?* If yes, document it here.

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

Each file opens with a **YAML frontmatter** block. Four fields are required; extra fields are allowed and
preserved (the parser is tolerant) but not interpreted by the surface.

```yaml
---
title: Getting started          # human title — shown in the nav index and as the page heading
order: 1                        # number — sort weight WITHIN the subcategory (ascending)
category: getting-started       # stable kebab-case category KEY (from the manifest, §"IA")
subcategory: initial-setup      # stable kebab-case subcategory KEY (scoped under the category)
---
```

| Field         | Type   | Required | Meaning |
| ------------- | ------ | -------- | ------- |
| `title`       | string | yes      | The page title (nav + heading). Missing → falls back to the slug. |
| `order`       | number | yes      | Ascending sort **within** a subcategory. Missing/non-numeric → sorts last. |
| `category`    | string | yes      | The stable **category KEY** (kebab-case) from the manifest. The display LABEL lives in i18n. |
| `subcategory` | string | yes      | The stable **subcategory KEY** (kebab-case), scoped under `category`. Label in i18n. |

`category`/`subcategory` are stable **keys**, not display text — the human labels live in i18n (next section),
so the same tree renders localized en/es. The loader (`apps/web/lib/manual/loader.ts`) is **defensive**: a
half-authored page with a missing field gets a sensible default rather than crashing the render — but every
shipped page should set all four explicitly with keys **that exist in the manifest**.

## Information architecture — the two-level tree (issue #563)

The IA is a **two-level tree**: **Category → Subcategory → page**, in **importance order** (most important
category first). The ordering is **not** derived from `order` anymore — it is encoded once, explicitly, in the
**manifest**:

```
apps/web/content/manual/_nav.ts   # the single source of importance ordering
```

`_nav.ts` exports `MANUAL_NAV`: an ordered array of `{ category: <key>, subcategories: [<key>, …] }`. **Keys
only — no labels.** It is the authoritative tree (the 13 ratified categories of ADR-0062 §5). Both this Help
surface and the content fan-out read from it.

The `/help` index + sidebar group pages into this tree:

- **Category order:** manifest order (importance). **Subcategory order:** the per-category manifest order.
- **Within a subcategory:** ascending `order`, then alphabetical by `title`, then by `slug` (stable tiebreak).
- **Only NON-EMPTY buckets render.** A category/subcategory with zero pages does **not** appear — the sidebar
  grows as content lands, never showing an empty bucket. So a brand-new manifest entry is invisible until its
  first page exists.
- **Orphans don't crash.** A page whose `category`/`subcategory` isn't in the manifest is tolerated: it sorts to
  the **end** and the loader emits a dev warning. Fix the frontmatter key (or add it to the manifest).

### Labels live in i18n (not in frontmatter)

The display text for every category and subcategory lives in `apps/web/messages/<locale>/help.json`, en + es in
parity:

```jsonc
{
  "categories": { "getting-started": "Getting started", … },
  "subcategories": {
    "getting-started": { "initial-setup": "Initial setup", … },
    …
  }
}
```

Subcategory labels are **scoped under their category key** (`subcategories.<category>.<subcategory>`), so the
same human name under two categories never collides. To **add or rename** a category/subcategory: edit
`_nav.ts` (the key + ordering) **and** add its label to both `en/help.json` and `es/help.json`. The nav
components resolve labels client-side via `useTranslations`; the index page and the search index resolve them
server-side.

## Navigation & search (issue #560)

Every Help route (`/help` AND `/help/<slug>`) is wrapped by a **persistent left sidebar** —
`apps/web/app/(marketing)/help/layout.tsx` (a Server Component) — that loads the page tree once and renders the
nav beside the page content. The sidebar is **manifest + frontmatter-driven**: the same Category → Subcategory →
pages tree the index uses, in importance order, with **collapsible subcategories** (native `<details>`, open by
default) and the **active page highlighted** (its subcategory is forced open). There is **nothing to register** —
add a page (per "How to add a Help page" below) and it appears under its category/subcategory automatically. On
desktop (lg+) the rail is always visible; on mobile it collapses into a "Browse" drawer (a shadcn `Sheet`). The
sidebar/search components live under `apps/web/app/(marketing)/help/_components/`.

At the top of the sidebar is a **simple, client-side search** box. It is deliberately **NOT Meilisearch** —
ADR-0062 §6 defers full-text search; this is a lightweight, in-memory filter with **no server call and no Meili
index**. The loader builds a small per-locale index at request time (`buildManualSearchIndex` →
`{ slug, title, category, subcategory, headings[], excerpt }`, where `category`/`subcategory` are the **localized
labels** and headings + a short plaintext excerpt are extracted from the body) and the client filters it as you
type: **accent-insensitive** (so "configuracion" matches "configuración"), substring, **title-first** ranking
(title > category > subcategory > heading > excerpt). The match/rank logic is the pure, unit-tested
`apps/web/lib/manual/search.ts` (`normalizeForSearch`, `searchManual`, plus the `extractHeadings` /
`buildExcerpt` index builders). What this means for authoring: a clear, distinctive **`title`**, the right
**`category`/`subcategory`**, and descriptive **`#`/`##` headings** are what make a page findable — the same
fields the IA already rewards.

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
(`apps/web/scripts/check-manual-parity.ts`) and runs as a **blocking CI step** in the `verify`
job (`.github/workflows/ci.yml`) — a PR with locale drift will fail CI.

## How to add a Help page

1. Pick a kebab-case **slug** (e.g. `permissions`).
2. Pick the page's **`category`** + **`subcategory`** KEYS from the manifest (`apps/web/content/manual/_nav.ts`).
   If the bucket you need doesn't exist yet, add the key to `_nav.ts` (in the right importance position) **and**
   its label to both `en/help.json` and `es/help.json` first.
3. Create **both** locale files with full frontmatter (`title`, `order`, `category`, `subcategory`):
   - `apps/web/content/manual/en/permissions.md`
   - `apps/web/content/manual/es/permissions.md`
4. Write plain product markdown. The Manual renders through the same `MarkdownView` the KB uses (GFM, code
   blocks, mermaid) **with `disableKbExtensions`** — so KB-only tokens (`[[slug]]` wiki-links and
   `{{ lazyit_secret.* }}` chips) render as **literal text**, never live elements. Link between Manual pages with
   ordinary relative links (`/help/<slug>`). **Never** reference a secret or a vault — the Manual is secret-free
   by construction ([[0062-in-app-help-manual-surface]] §3 / INV-10).
5. Run `bun run check:manual-parity` and confirm it passes.
6. The page appears automatically on `/help`, slotted under its `category` → `subcategory` (manifest order) and
   sorted by `order` — both on the index and in the **sidebar** — and becomes searchable in the sidebar search.
   No registration, no index file to edit.

## Related

- [[0062-in-app-help-manual-surface]] — the decision (public, code-versioned, KB-distinct; §6 defers Meili search).
- [[0051-i18n-next-intl]] — cookie-mode i18n, en + es, default/fallback `en`.
- [[i18n]] — translating the rest of the chrome (message catalogs).
- `apps/web/content/manual/_nav.ts` — the **IA manifest**: the ordered Category → Subcategory key tree (#563).
- `apps/web/components/markdown-view.tsx` — the renderer (`disableKbExtensions` prop).
- `apps/web/lib/manual/` — the loader (incl. `getManualCategories` + `buildManualSearchIndex`) + the pure, tested
  resolve/sort/`groupIntoCategories` and `search` (normalize/rank + heading/excerpt extraction) logic.
- `apps/web/app/(marketing)/help/layout.tsx` + `_components/` — the nested sidebar + simple client-side search.
- `apps/web/messages/{en,es}/help.json` — the category/subcategory display labels (en + es parity).
