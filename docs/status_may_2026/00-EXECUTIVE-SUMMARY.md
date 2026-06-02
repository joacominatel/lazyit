---
title: lazyit — Status Review (May 2026) — Round 1 closed, Round 2 backlog
tags: [status, review, executive-summary, backlog]
status: living
created: 2026-05-30
updated: 2026-06-01
---

# lazyit — Status Review (May 2026) → Round 1 + UX cycle closed, residual backlog

> The May-2026 multi-analyst review produced **218 findings**. **Round 1** shipped the urgent /
> quick-win cluster as **8 PRs (#61–#72)**; the **UX northstar cycle** then closed a large slice of the
> frontend/contract backlog as **PRs #100–#115**. This document is the **living record**: (A) Round 1,
> (A2) the UX cycle, (B) the prioritized Round-2 backlog with the CEO decisions that gate it, and
> (D) **what is still pending after the UX cycle**. Status verified against `dev` on 2026-06-01.
>
> The 22 per-analyst digest folders were removed in this cleanup: their *resolved* findings were
> noise and their *pending* findings are consolidated below. **They remain recoverable in git
> history** (last present at `d5b3b73`: `git show d5b3b73 -- docs/status_may_2026/<area>/analysis.md`).

---

## A. Round 1 — Delivered (merged to `dev`)

| PR | Area | What shipped |
|----|------|--------------|
| #62 | bugs | Consumable stock **lost-update race** fixed — atomic guarded `updateMany` (gte qty → 409) + int4 overflow → 409 / `P2020`→400 |
| #70 + #72 | perf / contracts | **Pagination** — `PageQuery`/`Page<T>` written into `@lazyit/shared`; rolled out on `/assets`, `/articles`, `/access-grants`; **lean list projections** (no `specs`/body/deep joins on lists); frontend unwraps `.items` |
| #67 | auth / ops | **Auth hardening**: `isActive` reject (both modes), no-resurrect of soft-deleted (403), JIT `upsert` race fix, RS256 pinning, `AUTH_MODE=shim` prod safeguard, **fail-loud zod boot config**, `@Public()`, `/health/live` + `/health/ready`; **offboarding cascade** (one tx: revoke grants + release assignments + soft-delete) |
| #61 | completeness | **Dashboard backend** — `GET /dashboard/summary` (counts/groupBy across pillars) |
| #63 | search | **Authoritative reindex** (swap, evicts ghosts), **fail-soft reads** (Meili down → empty, not 500), batching + task-wait |
| #65 | frontend/UX | **UX foundation** — brand accent + semantic tokens, mobile nav (Sheet/hamburger), dead UI removed (`/tickets`, `/settings`, "Open tickets"), **SEC-003** `rehype-sanitize`, `keepPreviousData`, `not-found.tsx`/`global-error.tsx`, skip-to-content |
| #66 | infra | **DR hardening** — base-image digest pinning, log rotation + `mem_limit`, Caddy security headers + `service_healthy` deps, backup runbook rewrite (no `down -v`, Zitadel DB + masterkey), `.env.prod` chmod guidance |
| #64 | docs | **Drift fixed** — README auth posture, `setup.md` env completeness, ADR-0016 marked superseded, `.env.example` (api + web), code-conventions (shadcn/heroicons) |

**Net:** the "most urgent + quick wins" tier from the review is done. The backend is now *authenticated,
hardened, paginated, and observable*. What remains is the **authorization, feature, and platform** build.

---

## A2. UX northstar cycle — Delivered (merged to `dev` 2026-06-01)

> A multi-wave UX/UI cycle (a 21-agent read-only audit → implemented in dependency waves) shipped
> **Fase 1+2 + four new surfaces** as PRs **#100–#115**. It closes a large slice of the Round-2 backlog
> below — chiefly the frontend Tier-2 items and the TIER-1 search/contract polish.

| PR | Area | What shipped |
|----|------|--------------|
| #104 | backend / contracts | Extended `Page<T>`/`PageQuery` with **`sort`+`dir`** (per-resource allowlist, unknown sort→400); migrated `GET /applications\|/consumables\|/users\|/locations` onto `Page<T>` + server `q`; re-added `deletedAt` to the asset-list lean owner projection; **KB reverse endpoints** `GET /assets/:id/articles` + `GET /applications/:id/articles`; **ADMIN batch** `POST /assets/batch/{delete,restore,status}` + `POST /access-grants/batch/revoke` (body `{ids}` → `{requested,succeeded,skipped}`, one audit entry per item). ADR-0030 amendment §6. No migration |
| #114 | backend / contracts | **`deleted=active\|only`** archived listing on the 5 lists (ADMIN-only for `only`, 400 invalid) over the ADR-0032 `includeSoftDeleted` hatch; confirmed `POST /<resource>/:id/restore` on all 5; **FIXED a pre-existing leak** — Consumable/ConsumableCategory were missing from `SOFT_DELETABLE_MODELS`, so `GET /consumables` had returned soft-deleted rows. ADR-0030 §7 + ADR-0041 cross-links |
| #102 | design system | Tuned `--success/--warning/--info` (+fg) for AA on the bone canvas (solid pills, light+dark — **ADR-0011 amendment 3**); `success/warning/info` Badge variants; new `StatusBadge{tone}`/`StatusDot` primitive; refactored per-entity status badges; `lib/avatar-color.ts` repurposing `--chart-1..5` as the categorical/avatar palette |
| #100 | chrome / IA | `PageHeader`, route-driven `Breadcrumb`, accessible `SearchInput`; **sidebar regrouped into 3 pillars + Manage** (Inventory: Assets+Consumables · Access: Applications · Knowledge: KB · Manage: Users/Locations/Settings); mobile shell gutter + icon-only global search below sm |
| #105 | hooks | `usePermissions`/`useCanWrite` (`canWrite===isAdmin`, fails closed while loading) + `useListParams` (URL-as-source-of-truth → the #104 params) + role badge in the user menu |
| #110 | list chain | All 6 list pages adopt PageHeader/SearchInput; **RBAC-gated** write affordances; **URL list-state** + server q/sort/dir + real pagination UI; `resource-table` responsive (`mobileChildren`/`ResourceCard`); `ActiveFilters` chips; dim departed owners; **dashboard "Needs attention" deep-links to pre-filtered lists** + freshness/Refresh + ADMIN quick-actions + shared `ErrorState` |
| #106 | hotfix | Web getters unwrap `.items` for the 4 newly-paginated lists (#104 merged briefly ahead of its consumer) |
| #111 | detail chain | `DetailPanel`/`DetailField`/`DetailSkeleton` on all 5 detail pages + KB; PageHeader+Breadcrumb on detail/edit/new; cross-links (Location, owner/actor); the 5 hand-rolled dialogs converged to RHF+zod (Field/FieldError/aria-invalid, onTouched, scroll-to-error); **KB runbooks UI** ("Related articles" on asset/app detail, "Linked to" on the article); dialog sizing; `FieldLabel required` |
| #108 | settings | **NEW ADMIN-gated `/settings`** (landing + `/taxonomies` CRUD for the 4 category kinds + asset-models + `/roles` overview + `/instance` config-status); completed the web category/asset-model write data layer; Settings sidebar entry |
| #112 | bulk / restore | `resource-table` row selection (`checkbox`, `use-row-selection`, `BatchActionBar`, `SelectCell`, `RestoreRowAction`); **bulk for assets** (delete/status/restore via #104) + **bulk restore** for consumables/users/locations (client per-id fan-out, `lib/api/per-id-batch.ts`); ADMIN-only "Show archived" toggle + per-row Restore; asset detail Category/Model cross-links |
| #115 | icons | Standardized on **@heroicons**, dropped `lucide-react` entirely; two-weight convention (`24/outline` + `16/solid`); **ADR-0045** + ADR-0011/code-conventions annotations |

**Net:** the frontend now matches backend capability — paginated/sorted/searchable RBAC-gated lists,
shared chrome + detail layout, restore + bulk, an admin settings area, KB runbooks, and a consolidated
icon set. The remaining gaps are recorded in **§D (Still pending after the UX cycle)** below.

---

## B. Round 2 — Prioritized backlog

### TIER 0 — The gating decision: **RBAC / authorization (still absent)**

Verified: **no** `Role`/`Permission`/`isAdmin` anywhere (`schema.prisma:19-53`); the only authz check
in the whole backend is KB author-only writes (`articles.service.ts`). The global `JwtAuthGuard` only
*authenticates*. Any IdP account holder can self-grant admin on an `isCritical` app, revoke anyone's
access, read the whole org access map, and soft-delete any user.

**Gates:** AccessRequest approval, access reviews, `isCritical`/separation-of-duties gating, per-caller
search authorization, destructive-delete protection, audit-feed scoping. **Nothing higher-order in the
Access pillar can be built trustworthily without it.**

**CTO recommendation:** smallest opinionated RBAC for a 2–20-person team — a single `Role` enum on
`User` `{ADMIN, MEMBER, VIEWER}` (default `MEMBER`; first JIT user / seed = `ADMIN`), resolved by the
guard onto `request.user`, enforced by `@Roles()` + a `RolesGuard` composing *after* the auth guard.
Gate Access writes, Users, and destructive deletes to `ADMIN`. **Resist** a per-resource ACL matrix.

### CEO decisions that gate Round 2 (escalations — answer these to unblock)

1. **RBAC shape** — approve `{ADMIN, MEMBER, VIEWER}` (rec) vs richer. New ADR. Blocks the entire Access build-out.
2. **Soft-delete reuse policy** — when an entity is soft-deleted, does recreating the same email/slug/sku
   **restore** the old row or **create fresh**? Determines restore endpoints vs partial unique indexes
   `WHERE "deletedAt" IS NULL`; also drives the **case-insensitive email** fix (citext / functional index).
3. **Async workers (BullMQ + Redis)** — adds Redis to the "one-command setup". Unblocks warranty/EOL
   alerts, grant-expiry auto-revoke/notify, low-stock reorder, KB staleness, **and** SEC-002 (.docx bomb worker).
4. **KB depth** — append-only **`ArticleVersion`** (edits currently destroy history — violates auditability)
   + **article↔asset/application linking**. Both are schema changes.

### TIER 1 — Urgent / correctness, small effort, no decision needed

- **`actor:null` in OIDC audit logs** (regression). `resolveActor()` still reads the dead `x-user-id`
  header → prod logs lose the actor. One-liner: read `request.user?.id`. (`logging/logging.config.ts`)
- **RELEASED asset-history has no `userId` payload** — disambiguates multi-owner timelines. (`asset-assignments.service.ts`)
- **Soft-deleted asset/user can still receive assignments** — no `assertUsable` guards (only access-grants guards). (`asset-assignments.service.ts:77-102`)
- **Cross-field zod refines** — `expiresAt >= grantedAt`, reject `from > to` ranges, reject empty `{}` PATCH.
- **`SPECS_CHANGED` false-positive** — `JSON.stringify` key-order sensitive; use stable compare. (`assets.service.ts:315`)
- ✅ **`content` indexed in Meili** — DELIVERED (ADR-0042); runbook bodies are now searchable (PUBLISHED only).
- **cuid query-param validation** — garbage cuid returns `[]` not 400 (uuid path validates; cuid doesn't).
- **Contract polish** — unify boolean query-param truthiness; `GET /search` response DTO; `ApiErrorSchema` in OpenAPI; drop redundant per-controller `@ApiBearerAuth` (global added in `main.ts`).
- **JIT contract fallback** — `lastName=''` / `${sub}@unknown` still violate the `User` zod schema when userinfo is absent (mostly mitigated by #60); harden the fallback.

### TIER 2 — High-value build (medium effort, reuse what exists)

- ✅ **Dashboard frontend** — DELIVERED (Round 3 #82 wired summary + recent-activity; UX cycle #110 added "Needs attention" deep-links to pre-filtered lists, freshness/Refresh, ADMIN quick-actions, shared ErrorState).
- ✅ **Pagination UI** — DELIVERED (#110): prev/next + server sort/dir/q + URL list-state on all 6 lists; `GET /consumables` (and applications/users/locations) migrated onto `Page<T>` server-side (#104).
- **Query-param DTOs** — partially addressed: pagination/sort/`deleted` are now shared `PageQuery` params validated per resource (#104/#114). The broader unify-all-filters-into-`@Query()`-DTOs cleanup remains.
- **Surface collected-but-unqueried data** — `?warrantyExpired=`/`?expiringBefore=` (assets), grant `expiringBefore` filter, low-stock reorder report (+ `reorderQty`?). *(Still pending.)*
- **CSV bulk import/export** — assets & consumables (reuse the `.docx` multer+parse+per-row-validate pattern). Export = anti-lock-in guarantee. *(Still pending.)*
- ✅ **KB content search** + **`ArticleVersion`** + **article↔asset/app linking** — DELIVERED (ADR-0042 backend; UX cycle #104 reverse endpoints + #111 runbooks UI: "Related articles" on asset/app detail, "Linked to" on the article). *No version-history/rollback UI yet.*
- ✅ **Detail pages** — DELIVERED: `users/[id]` + `locations/[id]` plus all 5 detail pages converged on `DetailPanel`/`DetailField`/`DetailSkeleton` with cross-links (#111).
- **Access UX** — grant `expiresAt`/`notes` edit UI (backend exists), grant-dialog context + `accessLevel` vocab, flag deactivated grantees in lists. *(Still pending — grants live on the application detail; access-grants bulk-revoke data layer shipped #104 but no UI.)*
- **Auth guard per-request DB lookup** — add a short TTL cache (every request hits `findFirst(externalId)`). *(Still pending.)*
- ✅ **CRUD dedup (partial)** — the list-contract migration consolidated `Page<T>`/sort/`deleted` parsing per resource; the broader `findOneOr404`/`softDelete`/`parseActiveOnly` helper extraction remains.

### TIER 3 — Platform maturation (larger / sequenced)

- **AccessRequest → approval → provision** workflow (needs RBAC). The headline Access feature.
- **Access reviews / recertification** + **separation-of-duties** gating on `isCritical` (needs RBAC).
- **Scheduler** (BullMQ + Redis, decision #3) → warranty/EOL alerts, grant-expiry auto-revoke, low-stock reorder, KB staleness, SEC-002.
- **Integration test tier** (Testcontainers / CI Postgres) — **keystone**. DB-enforced invariants (double-assign 409, FK Restrict, stock race, soft-delete proxy) are tested **nowhere**; the lone e2e test is stale (expects `Hello World` 200, now 401) and excluded from CI; the JWKS path is fully mocked. A wrong migration passes the whole green suite.
- **Activity feed** / unified cross-pillar event stream.
- **KB attachments / file storage** (decision), article export (.md).
- **Inventory depth** — location hierarchy (Site→Building→Room→Rack, ADR-0017 follow-up), asset maintenance log, bulk assign/transfer, asset-tag lookup.
- **Frontend platform** — RSC migration (ADR-0020's deferral trigger is now met — auth landed), optimistic updates (`onMutate` rollback), charting library decision, detail-page scaffolding dedup, session-token race guard.
- **DevOps** — CD / GHCR publishing (ADR-0027 deferred), backup automation sidecar, CI coverage step.

### ⚠️ Migration sequencing note (the footgun)

RBAC, email `citext`, soft-delete partial unique indexes + restore, `ArticleVersion`, `AccessRequest`,
`AccessEvent`, and any scheduler tables **all touch the Prisma schema / migrations**. Parallel
worktree agents on the schema produce **migration-ordering conflicts** (we hit this in Round 1).
**Schema-touching work must be serialized through one migration lane**, not fanned out in parallel.
Non-schema work (frontend, tests, docs, contract polish, search) can parallelize freely.

### Data-model debt (low, schema-touching — fold into the decisions above)

Append-only `int4` PK ceiling (AssetHistory/ConsumableMovement); no DB-level jsonb guard;
append-only immutability not enforced by triggers; `AccessGrant` allows N identical active grants
(ADR-0023 intentional — revisit when RBAC lands).

### Docs debt (CTO-owned)

The CTO references `system-map.md` + `decision-history.md` were refreshed again post-UX-cycle (this PR).
Still pending (separate doc PRs): `docs/06-security/summary.md` + `deferred.md` still describe an
unauthenticated API; entity docs still cite `X-User-Id` as the actor source (now `@CurrentUser()`);
`status_may_2026` vault hygiene (`_MOC`/frontmatter).

---

## D. Still pending after the UX cycle

> A living, honest record of what the UX cycle deliberately did **not** finish. None of these block the
> shipped surfaces; they are the next polish/feature waves.

### Phase-3 UX polish (deferred from the cycle)

- **Unified `Timeline` primitive** — AssetHistory, the recent-activity feed, and the consumable ledger
  still render bespoke timelines; no shared component yet.
- **Command palette / quick-create-from-anywhere** — `GlobalSearch` is search-only (Cmd+K → GET /search);
  no global "create asset/article/…" action surface.
- **Asset specs-editor niceties** — `CustomFieldsEditor` works but lacks the planned ergonomics (typed
  field templates, reorder, validation hints).
- **Unsaved-changes guards** — forms don't warn on navigate-away with a dirty state.
- **Table ergonomics** — sticky header, column visibility, density toggle not built (the responsive
  `ResourceTable` + selection shipped; these refinements did not).
- **Two-column detail with a history rail** — detail pages are single-column; the planned
  detail + side history/activity layout is deferred.
- **Brand logo asset** — no finalized logo; the wordmark/placeholder stands.

### Capability gaps with data layer ready

- **Access-grants bulk-revoke UI** — `POST /access-grants/batch/revoke` + `useBatchRevokeGrants` exist
  (#104) but are **NOT wired to any UI**: there is no owned grants table among the list pages (grants live
  on the application detail). Wiring needs a grants surface to host the selection + BatchActionBar.

### Server-side filters still client-side (over the loaded page)

- **Applications** category/criticality, **Users** status, **Locations** type filters run **client-side**
  over the current page (the backend has no such query param). Fine while lists fit one page; promote to
  server filters when they routinely page.
- **Asset Model deep-link** resolves **by Category only** — there is no server `model` filter, so a
  model deep-link narrows to the category, not the exact model.

### Carried over from Round 2 (unchanged by the UX cycle)

- Read-authorization model (all GETs open to any authenticated user, incl. VIEWER) — next AuthZ wave.
- Revoke/release race-guarding; DB indexes / `pg_trgm`; integration-test tier; CSV import/export;
  warranty/expiry read filters; scheduler (BullMQ + Redis); the broader query-param `@Query()` DTO unify
  + CRUD helper extraction. See §B above and `references/system-map.md` "Known debt".

---

## Index

This folder now contains only this summary and `README.md`. The historical per-analyst digests are in
git history at `d5b3b73`. Round-2 work items are dispatched from the backlog above via per-agent task
prompts (CTO `references/prompt-templates/`).
