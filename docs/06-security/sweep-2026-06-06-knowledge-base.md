---
title: Sweep 2026-06-06 — Knowledge Base (articles, article-categories, search)
tags: [security, sweep, articles, search]
status: draft
created: 2026-06-06
updated: 2026-06-06
---

# Sweep 2026-06-06 — Knowledge Base + Search

Deep audit of the KB and search domains and their integration points, per
`.claude/skills/lazyit-sentinel/SKILL.md`. **Find, don't fix** — only `docs/06-security/` was
written. The API was not run; all PoCs are reasoned from the code.

## Scope

- `apps/api/src/articles` — article CRUD, versioning, links, the `.md`/`.txt`/`.docx` import
  pipeline (`article-import.ts`), draft-vs-published visibility via the `X-User-Id` shim, the
  author-only write gate, metadata jsonb.
- `apps/api/src/article-categories` — category CRUD, `assertCategoryUsable` vs soft-deleted parent.
- `apps/api/src/search` — Meilisearch architecture, query handling, indexed entities/projection, the
  `users`-facet authZ drop, injection surface.
- Integration: `@lazyit/shared` article/search schemas, the global `JwtAuthGuard` shim path, the
  Prisma soft-delete extension, `mammoth`/`@xmldom/xmldom`/`jszip` import deps, Express body limits.

Reference ADRs read: 0021 (KB design), 0022 (draft-visibility shim), 0029 (untrusted-content
sanitization), 0035 (search architecture), 0042 (article versioning/linking), plus INVARIANTS,
deferred.md, SEC-001/002/003/007/008.

## Findings this sweep

| ID | Sev | Module | One-line |
| --- | --- | --- | --- |
| [[SEC-060-article-restore-skips-category-usable-guard\|SEC-060]] | 🟡 Low | articles | `restore()` skips `assertCategoryUsable` — a restored article can point at a soft-deleted category |
| [[SEC-061-search-returns-full-article-content-in-hits\|SEC-061]] | 🟡 Low | search | `/search` returns the full article markdown body per hit (response amplification + undocumented field) |

No Critical / High found. Reserved range SEC-060..SEC-069 — **2 of 10 used** (SEC-062..069 free,
range not exhausted).

## Verification of the OPEN import-pipeline findings (asked to re-confirm)

- **SEC-002 (.docx decompression bomb) — accurate, still open/deferred.** The only size control on
  the import is `file.size > maxImportBytes()` (`articles.service.ts:517`) plus the multer interceptor
  cap (SEC-001 fix, `articles.controller.ts:315-317`), both on the **compressed** upload (~5 MB).
  `mammothMd.convertToMarkdown({ buffer })` (`article-import.ts:70-72`) unzips + parses in memory, so a
  limit-compliant, highly-compressible `.docx` still expands unbounded at parse time. Characterization
  matches the code; the user-accepted decision (defer to the future BullMQ/Redis worker, interim bound
  = the ~5 MB compressed cap) stands. Not re-filed.
- **SEC-003 (asymmetric/bypassable markdown sanitizer) — accurate, still open/latent.** The
  bypassable import-only regex strip has been **removed** (`article-import.ts:48-52` comment; ADR-0029);
  imported content is now stored verbatim, identical to `POST`/`PATCH /articles`
  (`articles.service.ts:343,382`). There is no KB renderer yet, so stored markdown is latent XSS, not
  live. Authoritative defense is render-time on the (not-yet-built) web app. Not re-filed.
- **SEC-001 (unbounded upload DoS) — fixed, verified still in place.** `FileInterceptor('file', {
  limits: { fileSize: maxImportBytes() } })` aborts the stream early; the service `file.size` check
  remains as defense in depth. Confirmed closed.

## Verified clean (checked this sweep — a regression here would be a finding)

- **Draft visibility matches ADR-0022 exactly.** Non-author draft read → **404** (no existence leak)
  via `findOne`/`findBySlug` (`articles.service.ts:311,323`); non-author write on a PUBLISHED article →
  **403**, non-author/draft → **404** via `loadOwned` (`:790-804`); a write with no resolved user →
  **400** via `requireAuthor` (`:828-841`). `authorId` is taken from the principal, never the body
  (`CreateArticleSchema` has no `authorId`). Version reads (`listVersions`/`findVersion`) and
  `findLinks` reuse `findOne`'s gate, so a draft's history/links never leak. Reverse lookups
  (`findArticlesForAsset`/`findArticlesForApplication`) hard-pin `status: 'PUBLISHED'` — no draft leak.
- **Mass assignment contained.** All article create/update/import/link payloads are `z.strictObject`
  (unknown keys rejected); `UpdateArticleSchema` omits `status` (publish/unpublish own it) and
  `authorId`; `id`/timestamps/`publishedAt`/`lastEditedById` are server-set. Service-account principals
  are rejected with 403 on every article write (`requireAuthor`, INV-SA-4) — no null-attributed
  version/link rows.
- **Search authZ — `users` facet drop is correct and fail-closed.** `allowedEntities`
  (`search.controller.ts:97-109`) removes the `users` index unless the caller holds `user:read`
  (resolved DB-first via `PermissionResolverService`), for both explicit `entities=users` and the
  implicit "search all"; a deprivileged caller asking only for `users` short-circuits to an empty
  envelope. An anonymous/shim-less or service-account caller (no `request.user`) is treated as lacking
  `user:read` → `users` dropped. Matches ADR-0046 P3; stricter than ADR-0035's "no authz on search yet".
- **No query injection in search.** `q` is a Meili full-text term (not a filter expression); no
  `filter`/`sort` is exposed to the caller. `entities` is intersected with the `SEARCH_INDEXES`
  allow-list (unknown/garbage → ignored); `limit` is clamped to 1..50. No SQL is involved.
- **No SQLi / command injection / fs writes in scope.** No `$queryRaw`/`$executeRaw` in articles/
  article-categories/search (the only raw SQL is `health` `SELECT 1` and `dashboard`'s parameterized
  `Prisma.sql` view read). No `child_process`/`exec`/`eval`. The import never touches disk — it parses
  from the in-memory buffer — so no path traversal / zip-slip; `titleFromFilename` strips the path and
  feeds only the title (`article-import.ts:42-46`).
- **Article list `q` filter.** `contains` with `mode: 'insensitive'` over title/excerpt; Prisma
  parameterizes and escapes LIKE metacharacters, so no wildcard/LIKE injection. Query-string length is
  bounded by Node's request-line/header limits.
- **`assertCategoryUsable` guards create/update against a soft-deleted category** (soft-delete-filtered
  `findFirst`). The restore path is the one gap → SEC-060.
- **Soft-delete reads are consistent.** The Prisma extension scopes `findFirst`/`findMany`/`count`/
  `aggregate` to `deletedAt: null` for `Article`/`ArticleCategory`; the `includeSoftDeleted` escape
  hatch is used only by `restore` and the SA/JIT guard lookups.
- **Draft content never indexed.** `create`/`import` index only when `status === 'PUBLISHED'`;
  `update` re-syncs (upsert if PUBLISHED, else remove); `unpublish`/`remove` drop the doc; `reindex`
  is a full rebuild from the live+PUBLISHED set. Search-ghost staleness on a dropped fire-and-forget
  sync is acknowledged eventual-consistency debt (ADR-0035), repaired by `reindex:all`.
- **Body size.** `main.ts` sets no custom body-parser limit, so article JSON bodies (`content`,
  `metadata`) are bounded by Express's default ~100 kB; the import multipart path is bounded by the
  multer interceptor cap (SEC-001), with the decompression caveat (SEC-002).

## Integration risks / notes (not findings this sweep)

- **XXE / XML-entity expansion in `mammoth` (deps phase, reasoned-clean).** Import uses `mammoth@1.12.0`
  → `@xmldom/xmldom@0.8.13` + `jszip@3.10.1`. `@xmldom/xmldom` does not resolve external SYSTEM
  entities (no file/network fetch — no classic XXE/SSRF) and does not recursively expand custom internal
  entities, so a billion-laughs amplification via `word/document.xml` is not effective in this parser.
  The genuine amplification vector is **zip decompression** (SEC-002), not XML entities. Dependency
  CVEs remain a deferred phase (SKILL §1) — re-confirm if `mammoth`/`@xmldom/xmldom` is upgraded or the
  parser is swapped (e.g. to `convertToHtml` + turndown).
- **Content-type confusion — none.** Import dispatches purely by lowercased file **extension**
  (`extensionOf`), ignoring the multipart `Content-Type`; an unknown/missing extension → 400. There is
  no path where a `.md`/`.txt` is fed to `mammoth` or vice-versa, so no content-type confusion vuln.
- **`metadata` jsonb is unvalidated** (`z.record(z.string(), z.unknown())`) — accepted debt DEF-004 /
  ADR-0007/0021. Stored, not executed server-side; the dangerous sink is the future render layer
  (rolls into the ADR-0029 render-time policy, with SEC-003/SEC-008).
- **SSRF via article links — none server-side.** `ArticleLink` targets an internal `Asset`/
  `Application` by id (validated live via `assertAssetUsable`/`assertApplicationUsable`); article
  `content` may contain arbitrary URLs but the backend never fetches them. URL-as-href XSS is the
  frontend render concern already tracked by SEC-003/SEC-008 (latent).
- **`/search` returns more than `ArticleHitSchema` documents** → SEC-061 (the `content` over-return).

## Coverage & gaps

- **Covered:** every articles/article-categories/search endpoint mapped end-to-end; the draft-visibility
  state machine vs ADR-0022; the import pipeline (size caps, format dispatch, filename/title, sanitizer
  removal); the search authZ facet drop; the indexed projection vs the wire contract; soft-delete
  consistency incl. the restore edge; the cheap injection/exec/fs invariants.
- **Reasoned, not exercised:** the `nestjs-zod` global pipe boundary for multipart `@Body()` fields
  (even if unvalidated, `categoryId`/`status` reach only parameterized Prisma / enum checks → no
  injection); `mammoth`/`@xmldom` internals (deps phase); no dynamic testing (API not run).
- **Out of scope:** frontend (`apps/web`, the render sink for SEC-003/SEC-008/061-content),
  dependency CVEs, deploy infra.

Related: [[summary]] · [[INVARIANTS]] · [[deferred]] · [[SEC-002-docx-decompression-bomb]] ·
[[SEC-003-markdown-sanitizer-bypass-asymmetric]] · [[SEC-007-no-pagination-list-endpoints]] ·
[[06-security/_MOC|Security MOC]]
