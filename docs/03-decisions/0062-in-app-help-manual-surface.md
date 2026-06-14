---
title: "ADR-0062: In-app Help / Manual surface — shipped product documentation, distinct from the KB"
tags: [adr, web, frontend, docs, help, knowledge-base, i18n]
status: proposed
created: 2026-06-14
updated: 2026-06-14
deciders: [Joaquín Minatel]
---

# ADR-0062: In-app Help / Manual surface — shipped product documentation, distinct from the KB

## Status

**proposed** — 2026-06-14 (issue #454). The CEO has set the direction (quoted below); this ADR records
the **approach** so the prose can be ratified before any build. It is an **EPIC**: the implementation is
a later wave, not part of this record. It deliberately sits **beside**, and is distinct from, the
user-authored Knowledge Base ([[0021-knowledge-base-design]] / [[0042-article-versioning-and-linking]] /
[[0059-kb-folders-links-and-import]] / [[0060-kb-folder-access-control]]).

> **Scope of this ADR.** A **fixed, curated, shipped-with-the-product documentation surface inside the
> app** — the *Manual* / *Help* — authored as **markdown in the repo**, rendered by the existing
> `MarkdownView` component (`apps/web/components/markdown-view.tsx`), **ungated** (every authenticated
> user) and **secret-free**.
> It is **not** the KB: the KB is operator-authored content with folders, versioning and per-folder ACLs;
> the Manual is the product's own documentation, versioned with the code. This ADR defines the model and
> the initial information architecture; it does **not** write the content tree or the page route.

## Context

The CEO's direction, verbatim:

> *"Como cualquier página de documentación, por ejemplo docs.lazyit.com — getting started, idiomas,
> configuración, servicios, permisos, buenas prácticas, explicación en detalle, y demás. Amplio."*

lazyit is sold as a self-hosted product for small IT teams. Operators need **the product's own
documentation** — how to get started, how the permission model works, how to configure services, the
recommended best practices — reachable **from inside the app**, without leaving for an external site or
asking the vendor. Today there is no such surface.

The obvious-but-wrong instinct is "put it in the KB". The KB is the wrong substrate, by design:

- **The KB is user-authored, mutable content** — `Article` rows in Postgres, with append-only versions
  ([[0042-article-versioning-and-linking]]), folders ([[0059-kb-folders-links-and-import]]) and
  **per-folder access control** ([[0060-kb-folder-access-control]] / INV-9). It is the operator's
  *runbooks and tribal knowledge*, scoped to who-may-see-what. Product documentation is the **opposite**:
  it ships with the code, it is the same for every install, every authenticated user should see it, and
  it must not be editable through the app (an operator editing the product manual in their DB would
  diverge from the shipped product and silently rot on the next upgrade).
- **Versioning by the wrong axis.** The Manual must version with the **code** (the v1.4 manual describes
  v1.4 behaviour), not with a per-row `ArticleVersion` ledger. Markdown in the repo gives that for free —
  a doc change rides the same PR as the feature it documents.

So the Manual needs its **own** surface: curated, code-versioned, ungated, read-only-in-app.

## Considered options

- **Markdown files in the repo, rendered by `MarkdownView` (chosen).** Author the Manual as
  `apps/web/content/manual/<locale>/*.md` with YAML frontmatter, render through the existing
  `MarkdownView` (`apps/web/components/markdown-view.tsx`). Versioned with the code, no DB, no migration, no ACL surface, no
  write path. The content is part of the product artifact; a feature PR can update its own doc page.
- **Reuse the KB (`Article` rows) for the Manual — rejected.** Wrong substrate (see Context): it would
  make the product manual editable-and-rottable through the app, subject it to per-folder ACLs (the
  Manual must be ungated), version it by the wrong axis, and blur the line the product needs between
  *the vendor's documentation* and *the operator's knowledge base*. It would also entangle the Manual
  with the KB's draft-visibility and folder-ACL logic for no benefit.
- **A hybrid external `docs.lazyit.com` site — deferred (noted as a future option).** The CEO named
  `docs.lazyit.com` as the *shape* of what they want, not necessarily a separate hosted site. An
  external docs site is a reasonable future addition (public marketing/SEO docs, deep-linkable URLs),
  but it is **out of scope here**: a self-hosted internal tool needs its help reachable **offline,
  inside the app**, behind the same auth, with no dependency on a public site. If an external site lands
  later, the in-repo markdown can be the **single source** that publishes to both. Deferred, not
  discarded.
- **A third-party in-app help widget / hosted docs SaaS — rejected.** Adds an external dependency and a
  data-egress / phone-home surface to a product whose whole positioning is self-hosted and offline-capable.

## Decision

Ship a **fixed product-documentation surface inside the app — the Manual** — authored as markdown in the
repo and rendered by the existing markdown view. The shape:

### 1. Distinct from the KB — a different thing, by design

The Manual is **not** the Knowledge Base and shares none of its storage or access model:

| | Knowledge Base ([[0059-kb-folders-links-and-import]]) | **Manual / Help (this ADR)** |
| --- | --- | --- |
| Author | the **operator** (in-app, with versions/drafts) | the **product** (shipped with the code) |
| Storage | `Article` rows in Postgres (mutable, soft-delete, `ArticleVersion`) | **markdown files in the repo** (code-versioned) |
| Access | **per-folder ACL** ([[0060-kb-folder-access-control]] / INV-9), draft visibility | **ungated** — every authenticated user |
| Editable in-app | yes | **no** (read-only; a PR changes it) |
| Versioning axis | per-article version ledger | the **product version** (the release) |

The two are complementary: the KB documents *the operator's estate*; the Manual documents *lazyit
itself*. They never share storage, and the Manual never reads from or writes to `Article`.

### 2. Source — markdown in the repo

- Content lives at **`apps/web/content/manual/<locale>/*.md`** — one markdown file per page, with a YAML
  **frontmatter** carrying at least `title`, `order` (in-section sort) and `section` (the IA bucket,
  §5). The frontmatter is the page's metadata; the markdown body is the content.
- Rendered by the existing **`MarkdownView`** (`apps/web/components/markdown-view.tsx`)
  — the same renderer the KB uses, so the Manual gets the same code blocks, mermaid, and typography for
  free. (The KB-only extensions that resolve against DB state — `[[slug]]` wiki-links into `Article`
  rows and the `{{ lazyit_secret.* }}` masked chip — are **KB-specific** and do **not** apply to Manual
  pages; the Manual is plain product markdown. Manual-internal links are ordinary relative links between
  Manual pages.)
- No new model, no migration, no DB write path. The content is a build-time artifact of `apps/web`.

### 3. Ungated and secret-free

- **Ungated.** The Manual is visible to **every authenticated user** — there is **no `manual:*`
  permission** and no per-page ACL. Product documentation is not sensitive; gating it would only get in
  the way. (This is the deliberate inverse of the KB's per-folder ACL — and the reason the Manual must
  not live in the KB.)
- **Secret-free.** The Manual **never** surfaces vault/secret content. It is static markdown that has no
  path to a `SecretItem`, no DEK, no decrypt chain — it respects the [[0061-secret-manager-zero-knowledge]]
  / **INV-10** boundary by construction, simply by **never touching it**. The masked-chip secret token is
  a KB render-time feature ([[0061-secret-manager-zero-knowledge]] §8) and is **not** wired into the
  Manual renderer.

### 4. i18n — per-locale markdown trees (en + es)

The Manual is internationalized the same way the rest of the chrome is — **en + es**, mirroring
[[0051-i18n-next-intl]]:

- One markdown tree **per locale**: `apps/web/content/manual/en/…` and `apps/web/content/manual/es/…`.
- The active page is selected by the same `NEXT_LOCALE` cookie next-intl already uses (no `/es/` URL
  prefix — consistent with ADR-0051's cookie-mode). `en` is the default/fallback; a page missing in
  `es` falls back to the `en` file (and is a documentation defect, the same parity discipline as the
  message catalogs).

### 5. Initial information architecture

The first sections, taken from the CEO's enumeration:

- **Getting started** — first run, the bootstrap wizard, creating users.
- **Languages** — switching locale, the en/es coverage.
- **Configuration** — settings, integrations, the permission matrix editor.
- **Services** — the moving parts (API, web, Postgres, Valkey, Meilisearch, Zitadel) and what each does.
- **Permissions** — the roles + configurable-permissions model in plain language
  ([[0046-roles-permissions-v2]]), how to scope MEMBER/VIEWER, the admin-only reads.
- **Best practices** — recommended operating conventions (naming, folder ACLs, vault membership hygiene).
- **Detailed explanations** — the deeper, per-area "how it really works" pages.

The IA is the **seed**, not the full content; the per-page authoring is the implementation wave.

## Consequences

- **Positive:**
  - A clear, in-app, **offline-capable** product-documentation surface — reachable behind the same auth,
    no dependency on a public site, no vendor round-trip.
  - **Code-versioned** documentation: a feature PR updates its own Manual page, so the docs version with
    the product instead of drifting in a DB.
  - **No new backend surface** — no model, migration, ACL, or write path. The Manual is a build artifact
    of `apps/web`, rendered by a component that already exists.
  - **Keeps the KB clean**: the operator's editable, access-tiered knowledge base stays exactly that; the
    product manual stays separate and shipped.
  - **i18n for free** via the existing next-intl cookie convention ([[0051-i18n-next-intl]]).
- **Negative / trade-offs (accepted):**
  - The Manual is **not editable in-app** — fixing a typo is a PR + redeploy, not an in-app edit. That is
    the intended property (product docs version with the product), not a defect.
  - **Two markdown trees to keep in parity** (en/es) — the same parity discipline as the message catalogs;
    a missing `es` page falls back to `en` and is a defect to close.
  - **An external `docs.lazyit.com` is deferred** — if/when it lands it is a separate ADR; the in-repo
    markdown is positioned to be the single source for both.
- **Follow-ups (the implementation EPIC, a later wave):**
  - The `apps/web/content/manual/<locale>/*.md` tree + frontmatter convention, the Help/Manual route and
    navigation, the section index, and the en/es content fan-out.
  - **Ratify this ADR's prose** (flip `proposed` → `accepted`) before the build starts.
  - Revisit the hybrid external `docs.lazyit.com` as its own future ADR if a public docs site is wanted.

**Related:** #454 · [[0021-knowledge-base-design]] · [[0042-article-versioning-and-linking]] ·
[[0059-kb-folders-links-and-import]] · [[0060-kb-folder-access-control]] ·
[[0061-secret-manager-zero-knowledge]] (INV-10 — the Manual is secret-free) · [[0051-i18n-next-intl]] ·
[[0010-nextjs-frontend]] · `apps/web/components/markdown-view.tsx` · [[INVARIANTS]] (INV-10)
