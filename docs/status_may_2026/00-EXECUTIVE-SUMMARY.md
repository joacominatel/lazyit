---
title: lazyit — Status Review (May 2026) — Round 1 closed, Round 2 backlog
tags: [status, review, executive-summary, backlog]
status: living
created: 2026-05-30
updated: 2026-06-01
---

# lazyit — Status Review (May 2026) → Round 1 closed, Round 2 backlog

> The May-2026 multi-analyst review produced **218 findings**. **Round 1** shipped the urgent /
> quick-win cluster as **8 PRs (#61–#72)**. This document is now the **living record**: (A) what
> Round 1 delivered, and (B) the **Round 2 backlog** — everything still pending, prioritized, with
> the CEO decisions that gate it. Status verified against `dev` @ `d5b3b73` on 2026-06-01.
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
- **`content` not indexed in Meili** — KB runbook bodies are unsearchable. (`search/search.documents.ts`)
- **cuid query-param validation** — garbage cuid returns `[]` not 400 (uuid path validates; cuid doesn't).
- **Contract polish** — unify boolean query-param truthiness; `GET /search` response DTO; `ApiErrorSchema` in OpenAPI; drop redundant per-controller `@ApiBearerAuth` (global added in `main.ts`).
- **JIT contract fallback** — `lastName=''` / `${sub}@unknown` still violate the `User` zod schema when userinfo is absent (mostly mitigated by #60); harden the fallback.

### TIER 2 — High-value build (medium effort, reuse what exists)

- **Dashboard frontend** — wire `/dashboard` to `GET /dashboard/summary` + a "needs attention" zone
  (warranties expiring, lost/in-maintenance, low stock, expiring critical grants). Backend is **ready**; FE is still a static placeholder. **Top frontend pick.**
- **Pagination UI** — controls (prev/next/sort) wired to ADR-0030; also paginate the still-unbounded `GET /consumables` backend list.
- **Query-param DTOs** — unify the 6 inconsistent query/path validators into shared `@Query()` DTOs (bundle with pagination; auto-docs every filter).
- **Surface collected-but-unqueried data** — `?warrantyExpired=`/`?expiringBefore=` (assets), grant `expiringBefore` filter, low-stock reorder report (+ `reorderQty`?).
- **CSV bulk import/export** — assets & consumables (reuse the `.docx` multer+parse+per-row-validate pattern). Export = anti-lock-in guarantee.
- **KB content search** (TIER 1 quick win above) + **`ArticleVersion`** + **article↔asset/app linking** (gated by decision #4).
- **Detail pages** — `users/[id]` (unlocks per-user "who can access what" matrix) and `locations/[id]` ("assets here").
- **Access UX** — grant `expiresAt`/`notes` edit UI (backend exists), grant-dialog context + `accessLevel` vocab, flag deactivated grantees in lists.
- **Auth guard per-request DB lookup** — add a short TTL cache (every request hits `findFirst(externalId)`).
- **CRUD dedup** — extract `findOneOr404`/`softDelete` helpers; consolidate the duplicated `parseActiveOnly`.

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

This cleanup refreshes `system-map.md` + `decision-history.md`. Still pending (separate doc PRs):
`docs/06-security/summary.md` + `deferred.md` still describe an unauthenticated API; entity docs still
cite `X-User-Id` as the actor source (now `@CurrentUser()`); `status_may_2026` vault hygiene (`_MOC`/frontmatter).

---

## Index

This folder now contains only this summary and `README.md`. The historical per-analyst digests are in
git history at `d5b3b73`. Round-2 work items are dispatched from the backlog above via per-agent task
prompts (CTO `references/prompt-templates/`).
