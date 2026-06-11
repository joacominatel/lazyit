---
title: "ADR-0059: Knowledge Base v2 — folders, aliases, wiki-links & bulk import"
tags: [adr, knowledge-base, kb, folders, import]
status: accepted
created: 2026-06-11
updated: 2026-06-11
deciders: [Joaquín Minatel]
---

# ADR-0059: Knowledge Base v2 — folders, aliases, wiki-links & bulk import

## Status

> [!note] Decided — not yet integrated
> Ratified 2026-06-11 in a CTO/CEO design session; this ADR records the decision. **No code is built yet** — implementation is tracked by #364. Status is `accepted` (the decision stands), not `proposed`.

The third wave for the Knowledge Base. [[0021-knowledge-base-design]] shipped the **simple wiki** (one
`Article` + a **flat** [[article-category]], `LIKE`-only search, no versioning, no linking).
[[0042-article-versioning-and-linking]] added the first depth — append-only [[article-version]],
asset/application [[article-link]], content in search — but **explicitly deferred** article↔article and
article↔location links, and kept categories flat. This ADR resolves the structural debt the first two
ADRs left open: it gives the KB a **hierarchy** (folders), a **symlink** (aliases), **article↔article
wiki-links** (the ADR-0042 deferral), and **bulk `.zip` import**. It is the **data/UX foundation**;
[[0060-kb-folder-access-control]] (the very next ADR) builds the **permission boundary** on the
`Folder` this ADR introduces — read the two together.

## Context

The CEO approved a third KB wave on 2026-06-11. The simple wiki and its first depth are in production;
four gaps now bite a real, growing KB:

1. **Categories are FLAT, and one runbook lives in exactly one bucket.** [[article-category]] has **no**
   `parentId`; [[article]] carries a **required** `categoryId` FK (`onDelete: Restrict`). A team of even
   ten people quickly wants `Servers / Linux / Provisioning` — a tree — and a single article that
   belongs conceptually in two places (a `vpn.corp.local` runbook that is both "Networking" and
   "Onboarding"). The flat model can express neither.
2. **There is no article↔article link.** [[0042-article-versioning-and-linking]] linking is
   **asset/application only** ("Linking is asset/application only — no article↔article or
   article↔location links" — *Consequences*). A runbook can point at THIS server, but not at the
   "How we rotate the VPN cert" runbook it depends on. For an IT-native wiki that is the most-wanted
   edge — the Obsidian-style `[[slug]]` this very docs vault runs on.
3. **There are no backlinks.** Even once article↔article edges exist, "what references this runbook?"
   needs the **reverse** index — the single most useful KB navigation affordance and impossible to
   answer cheaply without a materialized edge table.
4. **Import is one file at a time.** The async import worker (`apps/api/src/articles/import/`, ADR-0053,
   SEC-002) takes a **single** `.md`/`.txt`/`.docx` per `POST /articles/import`. Migrating an existing
   wiki — a folder of markdown, an exported Obsidian/Notion vault — is a hundred manual uploads.

The forces and the substrate already paid for:

- **Append-improvable is the standing contract.** [[0021-knowledge-base-design]] designed every KB
  extension to be **non-destructive** — versioning was a new table, linking a join table, neither
  reshaped `Article`. This wave honours the same discipline: folders **evolve** the existing
  `ArticleCategory` (one new self-FK column), aliases and wiki-links are **new join tables**, and bulk
  import **extends the existing worker**. No `Article` column is reshaped; the required home-folder FK is
  the *same* `categoryId` FK, reframed.
- **The async sandboxed import worker exists and is hardened.** [[0053-async-workers-bullmq-valkey]] +
  SEC-002 already give us a forked, heap-capped child (`--max-old-space-size`,
  `importChildHeapMb()`) that OOMs on a `.docx` decompression bomb without touching the API process,
  returns `202 + jobId`, and is polled. `jszip` is already present but declared a **devDependency** (`apps/api/package.json`) — **promoting it to `dependencies` is a prerequisite of this build**, since the import worker uses it at runtime. A `.zip`
  is the **same threat class** as the `.docx` we already defend (both are ZIP containers) — extending
  the worker reuses the bomb guard rather than inventing a second pipeline.
- **Slugs are already org-unique among live rows.** [[article]]'s `slug` (`[a-z0-9-]`, ≤60,
  derived-from-title but editable) carries a **live-only PARTIAL unique index `WHERE "deletedAt" IS
  NULL`** ([[0041-soft-delete-reuse-and-restore]]). That is exactly the resolution key a `[[slug]]`
  wiki-link needs — but the **slug-auto-suffix-on-collision** question was left open by
  [[0021-knowledge-base-design]] ("on collision, auto-increment `-2`, `-3`? … not decided") and a
  collision still returns a bare `409`. A wiki-link and a bulk import that mints dozens of slugs at once
  force us to **resolve that open question now**.
- **Sanitization is render-time, not write-time.** [[0029-untrusted-content-sanitization]] fixed the KB
  policy: untrusted markdown is sanitized **when rendered**, never trusted at write. A `[[slug]]` is just
  more untrusted markup; its resolution is a **render-time concern**, not a stored hard FK that could
  block a save. This shapes §3 decisively.
- **Access tiering is coming, but is OUT of scope here.** Folders are about to become the KB permission
  boundary ([[0060-kb-folder-access-control]]). This ADR fixes the **shape** (the tree, the home-folder
  rule, the alias join) so 0060 can attach access to it; it deliberately ships **no access semantics** —
  an alias here is **navigation-only** (§2), and "who can see this folder" is entirely 0060's.

## Considered options

### Hierarchy model

- **Tags, not folders** — a many-to-many label join instead of a tree. *Rejected.* Tags were already
  deferred twice ([[0021-knowledge-base-design]] / [[0042-article-versioning-and-linking]]) and they
  answer a *different* question (cross-cutting facets), not the asked one (a browsable tree + a single
  authoritative home). Worse, a flat tag set gives [[0060-kb-folder-access-control]] **no** bounded set
  to attach access to — the very thing the next ADR needs. We may still add tags later; they are
  orthogonal, not a substitute.
- **A new `Folder` entity beside the old `ArticleCategory`** — keep categories, add a parallel tree.
  *Rejected.* Two overlapping grouping concepts is exactly the confusion [[0021-knowledge-base-design]]
  avoided by making categories user-managed-like-`asset-category`. It would orphan the existing required
  `categoryId` FK and every seeded category. **Evolving** `ArticleCategory` into `Folder` (add
  `parentId`) reuses the FK, the seed, the delete-guard and the soft-delete machinery — zero data
  migration of articles.
- **Evolve `ArticleCategory` → hierarchical `Folder` (chosen, §1).** One additive self-FK column; the
  flat set becomes the root level of a tree; the required one-category-per-article FK becomes the
  **one-home-folder-per-article** rule, unchanged in shape.

### Multi-placement (an article in two folders)

- **Many home folders per article** — make `Article.categoryId` a join table, N folders, no primary.
  *Rejected.* It dissolves "where does this *really* live", breaks the `Restrict`-on-delete guard
  ([[article-category]]'s 409), and — critically — gives [[0060-kb-folder-access-control]] **no single
  governing folder** for the access decision (which of N folders' permissions wins?). A document with
  three homes and three access tiers is unanswerable.
- **One home + symlink aliases (chosen, §2).** Exactly **one** home folder (the unchanged required FK)
  governs identity, delete-guard and — in 0060 — access; an **alias** lets the article *appear* in other
  folders for navigation **without** moving its home or widening its access. This is the Unix
  symlink/hardlink distinction, and it keeps the access decision single-valued for 0060.

### Article↔article link representation

- **A hard FK `[[slug]]` that blocks on an unresolved target** — store the link as a real
  `targetArticleId` FK, reject a save that references a not-yet-created slug. *Rejected, twice over.*
  (a) It contradicts [[0029-untrusted-content-sanitization]]'s render-time philosophy — a link's
  *validity* is a presentation concern, not a write-time gate; (b) it makes forward-references
  impossible (you could never link to a runbook you intend to write next), which is the whole point of a
  wiki; and (c) it makes **bulk import** (§5) a chicken-and-egg deadlock — you cannot import a vault of
  cross-linked notes if every `[[link]]` must resolve before its target row exists.
- **No stored edge — re-parse `content` on every read to find backlinks.** *Rejected.* "What references
  this?" would scan every article body on every detail view — an O(KB) full-text walk per request, the
  same N+1-shaped trap [[0042-article-versioning-and-linking]] avoided with the maintained `linkCount` /
  `readingMinutes` columns.
- **A materialized `ArticleWikiLink` edge, rebuilt on save (chosen, §3/§4).** The `[[slug]]` text is the
  source of truth in `content`; on each save we **recompute** the article's outgoing edges into a tiny
  current-state join (`sourceArticleId`, `targetSlug`, nullable `resolvedTargetId`). Resolution and
  backlinks become an indexed lookup; an **unresolved** slug is render-time state (a non-clickable
  tooltip), never a hard FK.

### Bulk import pipeline

- **A new, separate bulk-import service/queue.** *Rejected.* It would duplicate the SEC-002 sandbox, the
  heap cap, the bomb guard, the `202 + jobId` poll contract and the friendly-error mapping — two code
  paths to audit for the same threat class (a ZIP container). A `.zip` **is** a ZIP, exactly like the
  `.docx` the worker already defends.
- **Extend the existing async sandboxed worker to accept `.zip` (chosen, §5).** Same queue, same forked
  child, same bomb-guard *class*, same poll contract; only the unpack-and-fan-out logic is new, and it
  runs **inside** the existing isolation boundary.

## Decision

Five decisions. §1 reshapes the grouping model; §2–§4 add the three navigation primitives; §5 extends
the import worker. Throughout: **the model is fixed here, the migration mechanics are a build-time
detail** — this ADR does not write Prisma or SQL.

### §1 — Folders supersede flat categories

The existing **`ArticleCategory` is evolved into a hierarchical [[folder|Folder]]** by adding a single
**self-referential `parentId`** (`Folder.parentId → Folder.id`, nullable; `null` = a root folder). The
flat seed set becomes the root level of a tree.

- **One home folder per article — the existing FK, reframed.** [[article]] keeps its **required**
  `categoryId`/`folderId` FK (`onDelete: Restrict`): every article has **exactly one home folder**. This
  is the *same* column the simple wiki shipped; nothing about the article write path changes. The home
  folder is what [[0060-kb-folder-access-control]] will read as the **single governing folder** for the
  access decision (§2's aliases never compete with it).
- **Delete guard unchanged.** Deleting a folder that still has **live articles** stays a **`409`** (the
  `count`-in-service guard documented on [[article-category]]; the FK `Restrict` is the DB safety net for
  stray hard deletes). A folder with **child folders** follows the same posture — a non-empty subtree is
  not silently orphaned (the build defines whether that is a 409 or a guided reparent; the **rule** is
  "no silent orphaning", the mechanism is a follow-up).
- **Hierarchy invariants.** A folder may not be its own ancestor (no cycles — the same DFS guard
  [[0058-user-manager-and-clone-actions]] uses for the manager chain and [[0054-applications-workflow-engine]]
  §8 for the step graph; trees are shallow here, so the cost is negligible). Folder-name **uniqueness is
  scoped to the parent**, among **live** rows only: a **PARTIAL unique index on `(parentId, name) WHERE
  "deletedAt" IS NULL`** (raw SQL, not a PSL `@unique` — [[0041-soft-delete-reuse-and-restore]]), so
  `Servers/Linux` and `Workstations/Linux` coexist, and a soft-deleted folder frees its name within its
  parent for reuse/restore.
- **Conventions.** `Folder` stays a **mutable domain entity**: `cuid()` ([[0005-id-strategy]]),
  `createdAt` + `updatedAt` + `deletedAt` (soft delete, [[0006-soft-delete-and-auditing]]) — unchanged
  from `ArticleCategory`. The table **may keep its name or be renamed `folders`** at build time; this ADR
  fixes the **model**, not the migration mechanics.

> [!info] The forward reference to access control
> §1 ships **structure only** — a tree and a single home folder. **No access semantics live here.**
> [[0060-kb-folder-access-control]] attaches the permission boundary to this `Folder` (its proposed
> **INV-9**: KB folder access is evaluated DB-first at the API and enforced at the DB, never UI-only).
> This ADR's job is to make the boundary *exist as a bounded, named set* so 0060 can govern it.

### §2 — Aliases (folder symlinks)

A new **[[article-alias|ArticleAlias]]** lets an article **appear in another folder** without moving its
home (§1) — a Unix-style symlink. The home folder remains the one authoritative location; an alias is a
secondary, navigational placement.

- **MVP: navigation-only — an alias NEVER widens access.** This is the load-bearing constraint. The
  **home folder governs** identity and (in 0060) access; an alias is a pointer for *browsing*, **not** a
  share. There is **no access-granting column** on `ArticleAlias` in the MVP. A future "alias-as-share"
  (an alias that *does* grant access to the aliased article inside the alias folder) is **explicitly
  reserved to [[0060-kb-folder-access-control]]**, which owns every access rule — it is not in scope here
  and is not implied by this table.
- **Current-state join, hard-delete.** Mirroring [[article-link]]: `cuid()` ([[0005-id-strategy]]),
  **`createdAt` only — NO `updatedAt`/`deletedAt`** (it is a current-state placement, neither a
  soft-deletable domain entity nor an append-only audit log — [[0006-soft-delete-and-auditing]]). An
  alias is created via `POST` and removed via **hard `DELETE`**.
- **No duplicate placement.** At most one alias per `(folderId, articleId)` — a **PARTIAL unique index
  `WHERE "deletedAt" IS NULL`-equivalent** (the join has no `deletedAt`, so simply `UNIQUE(folderId,
  articleId)`; the partial form is the pattern when a soft-delete column exists — here it does not). An
  alias whose `folderId` **equals the article's home folder** is meaningless and rejected (you cannot
  alias an article into its own home). FKs `onDelete: Cascade` on both endpoints (an alias is meaningless
  without its article or its folder and carries no audit value — the [[article-link]] posture exactly).

### §3 — Wiki-links `[[slug]]`

Article↔article links — the [[0042-article-versioning-and-linking]] deferral — are authored **inline in
markdown** as `[[slug]]`, resolved against the **org-unique article slug**. This reuses
[[article]]'s existing live-only partial-unique slug ([[0041-soft-delete-reuse-and-restore]]) as the
resolution key and **does not add a hard FK to `content`**.

**Resolving the two standing open questions.** A `[[slug]]` link and a bulk import that mints many slugs
at once force the slug-collision question [[0021-knowledge-base-design]] left open. We decide:

- **Slug stays derived-from-title by default and editable** (unchanged from [[0021-knowledge-base-design]]).
- **On collision the slug is AUTO-SUFFIXED** (`-2`, `-3`, …) rather than returning a bare `409`. This
  resolves [[0021-knowledge-base-design]]'s open question ("auto-increment `-2`, `-3`?") **in the
  affirmative** and is what makes a frictionless wiki + bulk import possible. (An interactive single
  create may still surface the suffixed slug for the author to confirm/override; bulk import auto-suffixes
  silently and **reports** the rename — §5.)

**Unresolved links are render-time state, not a hard FK.** Per [[0029-untrusted-content-sanitization]]'s
render-time philosophy, a `[[slug]]` whose target does not exist (yet) renders as a **non-clickable**
link with a **tooltip** ("document not created yet") — a forward reference, not an error. A save **never**
blocks on an unresolved `[[slug]]`; you can link a runbook you intend to write next. When that target is
later created, the link resolves on the next rebuild — no edit to the source article required.

**A materialized `ArticleWikiLink` edge powers fast resolution.** Scanning bodies on every read is the
N+1 trap [[0042-article-versioning-and-linking]] avoided. Instead, on **every save** that changes
`content`, the article's **outgoing** wiki-links are recomputed (parse `[[slug]]` tokens) and the edge
table is **hard-rebuilt** for that source — `delete where sourceArticleId = …` then `insert` the current
set, **in the same `$transaction` as the article write** (the in-transaction discipline
[[0042-article-versioning-and-linking]] uses for the version snapshot, so the edge can never drift from
the body it describes).

- **[[article-wiki-link|ArticleWikiLink]]** columns: `sourceArticleId` (FK → [[article]]), `targetSlug`
  (the verbatim `[[slug]]` text, the resolution key), and a **nullable `resolvedTargetId`** (FK →
  [[article]], the matched article when the slug currently resolves to a live article, else `null` =
  unresolved). Current-state join: `cuid()` ([[0005-id-strategy]]), **`createdAt` only**, hard-rebuilt on
  save — never updated in place, never soft-deleted ([[0006-soft-delete-and-auditing]]). `onDelete:
  Cascade` from the source; `onDelete: SetNull` on `resolvedTargetId` is the **hard-delete** safety net. On the **normal soft-delete** path the FK does **not** fire (a soft delete only sets `deletedAt`, [[0032-soft-delete-middleware]]), so `resolvedTargetId` is **not** auto-cleared — staleness is harmless because the backlink read ANDs the soft-delete read filter + the article-read visibility gate, and the rebuild-on-save pass re-resolves the edge.
- **Resolution is best-effort and rebuildable.** `resolvedTargetId` is a **cache** of "the slug matched a
  live article at rebuild time", not a referential truth — the truth is the `targetSlug` string. A
  background or on-create pass can re-resolve previously-unresolved edges when a new article takes a
  long-awaited slug (a §5 import does this for the whole batch).

> [!note] `[[slug]]` resolves on slug, but a slug can change
> The edge stores the `targetSlug` **string**, so an editable/auto-suffixed slug (above) means a link can
> go stale if a target's slug is later changed. v1 accepts this (the link degrades to an unresolved
> tooltip — never a crash, never a wrong target); a slug-change "rewire my inbound links" pass is a
> follow-up, not MVP.

### §4 — Backlinks ("References")

Because §3 materializes the edge, the **reverse** lookup is a cheap indexed query. Each article's detail
view gains a **"References" section** listing the **incoming** wiki-links — every article whose
`ArticleWikiLink.resolvedTargetId` points at this one (`SELECT … WHERE resolvedTargetId = :id`, the
article-read visibility gate ANDed on top so a draft's backlink never leaks, [[0022-draft-visibility-auth-shim]]).

> [!info] "References" (article↔article) is DISTINCT from the ADR-0042 links panel
> [[0042-article-versioning-and-linking]] already ships an **ArticleLinksPanel** / "related" surface for
> **article↔asset/application** [[article-link]]s ("the runbook for THIS server"). The new **References**
> section is **article↔article** backlinks (`ArticleWikiLink`). They are two different relations, two
> different tables, two different UI affordances — do not conflate them. An article may have both: assets
> it documents (ArticleLink) *and* runbooks that reference it (ArticleWikiLink backlinks).

### §5 — Bulk `.zip` import

The existing async **sandboxed** import worker (`apps/api/src/articles/import/`,
[[0053-async-workers-bullmq-valkey]], SEC-002) is **extended** to accept a **`.zip`** in addition to the
single `.md`/`.txt`/`.docx`. **Same queue, same forked heap-capped child, same `202 + jobId` poll
contract** (`getStatus`) — only the unpack-and-fan-out is new, and it runs **inside** the existing
isolation boundary.

- **Selective extraction.** From the archive, take **only `.md`/`.txt` entries and the nested folder
  structure**; **ignore everything else** (images, `.docx` inside the zip in v1, dotfiles, binaries) —
  reported as skipped, never an error. **Nested zip folders auto-create app [[folder|Folder]]s mirroring
  the tree** (`§1`), so importing a folder of markdown reconstructs its hierarchy.
- **The bomb guard is the SAME class as the `.docx` guard.** A `.zip` is a ZIP container, exactly like a
  `.docx` — the SEC-002 threat (a decompression bomb that expands far past the heap cap) is identical, so
  the **same `importChildHeapMb()` cap + entry-count/total-uncompressed-size quota class** apply, run in
  the **same forked child** that already OOMs-and-respawns without touching the API process. No new
  isolation primitive; the existing one covers it. (`jszip` already exists as a **devDependency** — promote it to `dependencies` first; see the Migration surface.)
- **Slug collisions on bulk import: AUTO-SUFFIX** (§3) — `-2`, `-3`, … minted silently, and **every
  rename/skip is reported** in the per-item result so nothing is swallowed (the [[article]] slug stays
  derived-from-filename/title, editable later).
- **Best-effort `[[link]]` rewire.** After the batch is created, the worker makes a **best-effort pass**
  to rewire `[[links]]` inside the imported markdown to the freshly-created articles (matching by
  slug/filename), so a cross-linked vault arrives **already wired** rather than as a wall of unresolved
  tooltips. A link that still doesn't resolve degrades to the §3 tooltip — never a failure.
- **Contract unchanged.** Returns **`202 + jobId`**; the client **polls** the same `getStatus` surface;
  the result surfaces the batch outcome (created / renamed / skipped per item, the
  [[0030-list-pagination-contract|per-item batch]] shape). Author resolution is unchanged — a **human**
  caller only, **never** a service account (the worker already 403s an SA author).

> [!warning] Bulk import is a fan-out — bound it
> A single `.zip` can mint dozens of articles, folders, version-1 snapshots and wiki-link edges in one
> job. The entry-count/size quota (above) is the **DoS bound**; the per-item result is the **audit**. The
> job stays a single sandboxed child (SEC-002) — the fan-out is bounded work inside one isolated process,
> not a runaway enqueue of N child jobs.

### Migration surface (named, not written)

This ADR fixes the model; the build cuts the migration. The surface is small and **additive**:

- **`Folder`** (§1): add a self-FK **`parentId`** (nullable, `onDelete: …` per the no-silent-orphan rule)
  to the existing `ArticleCategory`/`folders` table; replace the flat-`name` unique with a **partial
  unique on `(parentId, name) WHERE "deletedAt" IS NULL`** (raw SQL). The existing `Article.categoryId`
  FK is **reframed** as the home-folder FK — **no article-row migration**.
- **`ArticleAlias`** (§2): a **new table** — `(folderId, articleId, createdAt)` (a trivial nav pointer — no actor/access column), `UNIQUE
  (folderId, articleId)`, both endpoint FKs `Cascade`, no access column.
- **`ArticleWikiLink`** (§3/§4): a **new table** — `(sourceArticleId, targetSlug, resolvedTargetId?,
  createdAt)`, indexed on `sourceArticleId` and `resolvedTargetId` (the backlink lookup), `Cascade` from
  source, `SetNull` on `resolvedTargetId`.
- **Dependency:** promote `jszip` from `devDependencies` to `dependencies` in `apps/api/package.json` — the bulk-import worker `import`s it at **runtime**, and `devDependencies` are pruned in the production image build.

No `Article` column is reshaped. The `@lazyit/shared` deltas (a `Folder` schema with `parentId`,
`ArticleAlias` / `ArticleWikiLink` schemas, the wiki-link parse/slug-suffix **pure** utils shared by
`api` and `web`) are a build follow-up, not written here.

## Consequences

- **Positive:**
  - The KB gains a **real hierarchy** (folders) with the **minimal** reshape — one self-FK on the
    existing category table — and a **single authoritative home** per article, preserving the
    `Restrict`/409 delete guard and the soft-delete-reuse semantics already understood and tested.
  - **Aliases** give multi-placement without ambiguity or a multi-FK mess, and — by carrying **no access
    column** — keep the access decision **single-valued** for [[0060-kb-folder-access-control]].
  - **Article↔article wiki-links** finally land the [[0042-article-versioning-and-linking]] deferral, as
    the Obsidian `[[slug]]` IT teams already know, with **forward references** and **cheap backlinks**
    (the materialized edge), and **no hard FK** to block a save or an import.
  - The two long-open **slug-collision** questions are **resolved** (auto-suffix), unblocking frictionless
    authoring and bulk migration.
  - **Bulk `.zip` import** reuses the hardened SEC-002 sandbox — one threat class, one bomb guard, one
    poll contract — so migrating an existing wiki is one upload, not a hundred.
  - Every addition is **append-improvable** ([[0021-knowledge-base-design]]): no `Article` column
    reshaped; folders evolve a column, aliases/wiki-links are new join tables, import extends a worker.
- **Negative / trade-offs (accepted):**
  - **A new materialized edge to keep in lockstep.** `ArticleWikiLink` is hard-rebuilt on every
    content-changing save (in the version-snapshot transaction); a bug there drifts backlinks from
    reality. Accepted: the rebuild is deterministic, transactional and cheaper than re-parsing on read.
  - **`resolvedTargetId` is a cache, and slugs can change** — a link can go stale to an unresolved
    tooltip (never a wrong target, never a crash). A slug-change inbound-rewire pass is **deferred**.
  - **Bulk import is a bounded fan-out** — dozens of rows + version snapshots + edges per job; the
    entry-count/size quota is the DoS bound, the per-item result the audit. More surface than the
    single-file path, contained in one sandboxed child.
  - **Hierarchy adds cycle-prevention and a non-empty-subtree delete rule** the flat model never had —
    modest, bounded (trees are shallow in a 5–20-person KB), but real.
  - **Folders are about to carry access semantics they do NOT have here.** This ADR ships structure only;
    a reader must not assume an alias or a folder grants/denies anything until
    [[0060-kb-folder-access-control]] lands. Stated loudly to prevent a premature access read.
- **Follow-ups:**
  - **[[0060-kb-folder-access-control]]** — the permission boundary on this `Folder` (INV-9;
    the "alias-as-share" reserved escalation; the 404-not-403 existence-hiding for folder-hidden
    articles).
  - The Prisma migration (§ *Migration surface*); the `@lazyit/shared` `Folder`/`ArticleAlias`/
    `ArticleWikiLink` schemas + the shared `[[slug]]`-parse and slug-auto-suffix **pure** utils; the
    wiki-link rebuild in the article write/import transactions; the References (backlinks) read; the
    web folder-tree sidebar, alias affordance, `[[slug]]` autocomplete + tooltip renderer, and the bulk
    `.zip` upload UI.
  - The new entity notes ([[folder]], [[article-alias]], [[article-wiki-link]]) and the
    [[article-category]] / [[article]] note updates marking the folder evolution.
  - A **slug-change inbound-rewire** pass; **tags** (still orthogonal, still deferred); `.docx`-inside-zip
    and richer import formats.

**Related:** [[0021-knowledge-base-design]] · [[0042-article-versioning-and-linking]] · [[0053-async-workers-bullmq-valkey]] · [[0029-untrusted-content-sanitization]] · [[0041-soft-delete-reuse-and-restore]] · [[0060-kb-folder-access-control]] · [[article]] · [[article-category]] · [[article-link]] · [[folder]] · [[article-alias]] · [[article-wiki-link]]
