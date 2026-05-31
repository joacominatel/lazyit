---
title: lazyit — Status Review (May 2026) — Executive Summary
tags: [status, review, executive-summary]
status: draft
created: 2026-05-30
updated: 2026-05-30
---

# lazyit — Status Review, May 2026 — Executive Summary

> CTO synthesis of a 22-analyst review fleet. Each analyst audited one lane (backend-weighted)
> and wrote a detailed report under `docs/status_may_2026/<folder>/analysis.md`. This file is the
> consolidated, prioritized view: **what is most urgent, what is fixable fast, and the path to a
> finished, large IT-ops platform** — grounded in the product vision (self-hosted, single-org,
> three pillars, asset-centric, "modern, not enterprise legacy").

## Method & scope

- **22 senior analysts**, ~2.23M tokens, 834 tool-uses, ~13 min.
- **218 findings** total. Severity: **1 Critical · 44 High · 94 Medium · 75 Low · 4 Info**.
- By category: feature 46 · infra 29 · frontend-ux 26 · code-quality 23 · docs 22 · security 21 · bug 20 · optimization 14 · testing 10 · refactor 7.
- Read-only pass: **no code or infra was modified**; the deliverable is analysis + this plan.

## Verdict in one paragraph

The backend is **clean, consistent, and correct in the small** (no dependency cycles, no N+1, a
sane global middleware stack, 291 green unit tests, well-documented schema). It is **unfinished and
ungoverned in the large**: the three pillars store the right data but barely *act* on it, and the
single most important gap is that **authentication landed without authorization** — every logged-in
user can do everything, including grant/revoke access to production systems. The fastest, highest-
trust wins cluster around **offboarding, the stock race, config fail-loudness, and doc drift**; the
biggest *build* levers are **RBAC → pagination → a real dashboard → access-request workflow**, most
of which reuse data and patterns that already exist.

---

## Cross-agent consensus (highest-confidence signals)

These were flagged **independently by multiple analysts** — treat them as the most reliable:

| Theme | Raised by | Severity |
|---|---|---|
| **No RBAC / authorization** (everyone is equal over the Access pillar) | backend-completeness, backend-auth, features-access | 🔴 Critical + 🟠 High ×2 |
| **Broken offboarding** (grants/assignments survive; deactivated users still authenticate; soft-deleted users get JIT-resurrected) | backend-completeness, backend-auth, features-access | 🟠 High ×4 |
| **No pagination** (ADR-0030 contract never even written into `shared`) | backend-performance, backend-api-contracts, shared-contracts, ux-inventory | 🟠 High |
| **Dashboard is a dead placeholder** advertising a non-pillar (Tickets) with no metrics endpoint | ux-dashboard, ux-design, features-knowledge, backend-completeness | 🟠 High |
| **Doc drift** (README says "unauthenticated", setup.md broken, system-map claims ArticleVersion exists) | docs-dx, backend-data-model, backend-auth, infra-ops, search | 🟠 High + quick-wins |
| **Consumable stock lost-update race** (untested, ADR-0034 over-promises) | backend-bugs, backend-testing | 🟠 High |

---

## TIER 0 — The one decision that gates the roadmap

### 🔴 Authorization model (RBAC) — needs a CEO decision + a new ADR

**Fact:** there is no `Role`/`Permission`/`isAdmin` anywhere (`schema.prisma:19-53`); the only
authorization check in the entire backend is KB author-only writes (`articles.service.ts:286`). The
global `JwtAuthGuard` **only authenticates**. So any IdP account holder can self-grant admin on an
`isCritical` production app, revoke anyone's access, read the whole org access map, and soft-delete
any user. ADR-0023 explicitly called this "acceptable only pre-auth" — and auth has now landed
(ADR-0037/38/39), so that precondition is gone.

**Why it gates everything:** AccessRequest approval, access reviews, separation-of-duties,
offboarding-by-role, and destructive-delete protection all need to know "who is allowed." Nothing
higher-order in the Access pillar can be built trustworthily without it.

**Recommendation (mine):** the *smallest* opinionated RBAC sized for a 2–20-person team — a single
`Role` enum on `User` `{ADMIN, MEMBER, VIEWER}` (default `MEMBER`; first JIT user / seed = `ADMIN`),
resolved by the guard onto `request.user`, enforced by a `@Roles()` decorator + `RolesGuard`
composing *after* the auth guard. Gate Access writes, Users, and destructive deletes to `ADMIN`.
**Resist** a per-resource ACL / permission matrix — that is the enterprise drift the product rejects.

→ Detail: `backend-auth-authz/analysis.md`, `backend-completeness-gaps/analysis.md`, `features-access-pillar/analysis.md`.

---

## TIER 1 — Urgent, mostly small-effort (do these next; high value/cost ratio)

1. **Offboarding integrity bundle** (🟠 bug/security, small). On user soft-delete, in one
   transaction: release active `AssetAssignment`s (`RELEASED` history) and revoke active
   `AccessGrant`s. Reject `isActive=false` in the guard (both modes). On the JIT path, look up
   `externalId` *including* soft-deleted rows → return 403 (do **not** re-provision), so offboarding
   sticks and audit links survive. *Today a departed employee still "holds" their laptop and keeps
   live access — the exact failure the Access pillar exists to prevent.* (`users.service.ts:46-56`,
   `jwt-auth.guard.ts:82,152-211`). Amend ADR-0038.
2. **Consumable stock lost-update race** (🟠 bug, small). `createMovement` does a JS read-modify-
   write under Read Committed; two concurrent `OUT`s can both pass the `nextStock<0` check and drive
   real stock negative, diverging the cache from the append-only ledger. Fix with atomic
   `updateMany({where:{id,currentStock:{gte:q}}})` (count 0 → 409) inside the ledger transaction.
   Amend ADR-0034's "can't diverge" wording. (`consumables.service.ts:101-141`).
3. **Case-insensitive email** (🟠 bug, small). `User.email` is case-sensitive TEXT; with OIDC/JIT
   live, `Bob@…` and `bob@…` create duplicate users and corrupt the audit trail. `citext` or
   lowercase + functional unique index. (`schema.prisma:21`).
4. **Fail-loud at boot + readiness probe** (🟠 infra, small). Missing `OIDC_ISSUER` is not caught at
   boot — the app starts "healthy" then 401s every request. Add a zod-validated config schema parsed
   before `NestFactory.create`, and a real `GET /health/ready` (`SELECT 1`) + a `@Public()`
   decorator (no health route can exist past the global guard today). Directly serves the
   "one-command setup, loud actionable errors" mandate. (`main.ts:7-44`, `app.controller.ts:8-11`).
5. **`AUTH_MODE=shim` production safeguard** (🟠 security, small). One stray env var fully disables
   auth. Throw at startup if `shim && NODE_ENV==='production'`; make OIDC the `.env.example` default.
6. **JWT hardening** (🟠 security, small). Pin `algorithms:['RS256']` in `jwtVerify`; replace the
   JIT `findFirst+create` race with `upsert` on `externalId` (kills intermittent first-login 500s).
7. **Authoritative reindex + fail-soft search reads** (🟠 security/bug, small–medium). `reindex:all`
   is additive-only, so a dropped fire-and-forget `remove()` leaves **soft-deleted user PII / DRAFT
   articles searchable forever** for every user. Make reindex `deleteAll`+re-add (or swap indexes);
   wrap `/search` reads so a Meili outage degrades to empty results, not a 500.
8. **`nextStock` int4 overflow** (🟡 bug, quick-win). Repeated/large `IN`/`ADJUSTMENT` overflows
   int4 → unhandled 500. Reject > `INT4_MAX` with 409 and/or map `P2020`→400 in the exception filter.

---

## TIER 2 — High-value build (medium effort, reuse what exists)

1. **Pagination (ADR-0030)** — quick-win first: write `PageQuery`/`Page<T>` into `@lazyit/shared`
   (the accepted contract was *never written*). Then roll out cursor-first on the heaviest/most-
   sensitive endpoints — `GET /access-grants` and `GET /assets` — front+back split per ADR-0020.
   Closes SEC-007.
2. **Dashboard** — add a `DashboardModule` with one read-only `GET /dashboard/summary` composing
   cheap `count()`/`groupBy` aggregates (the soft-delete extension already filters them). Drives a
   "needs attention" zone (warranties expiring, lost/in-maintenance assets, low stock, expiring
   critical-app grants) — **all signals already in the schema, never surfaced**. Remove the
   "Open tickets" card immediately.
3. **Lean list projections** (perf, small/medium). `GET /articles` ships the full markdown body of
   every article; `GET /assets` eager-loads a deep relation graph + `specs` jsonb for every row.
   Add list-specific `select`s / lean shared schemas. Compounds with pagination.
4. **Soft-delete vs unique-constraint collision** (bug, medium). Every `@unique` is a full index, so
   recreating a soft-deleted email/slug/sku 409s against an invisible ghost row — and there is **no
   restore endpoint anywhere**. Decide reuse-vs-restore policy, then partial unique indexes
   `WHERE "deletedAt" IS NULL` (the assignment table already does this) + restore endpoints.
5. **CSV bulk import/export** for assets & consumables (feature, medium). The onboarding wall for an
   IT generalist arriving with a Snipe-IT/GLPI export; the `.docx` import already proves the
   multer+parse+per-row-validate pattern. Export is also the concrete anti-lock-in guarantee.
6. **Surface the data already collected** (feature, small). `warrantyEnd`, `purchaseDate`, `minStock`,
   `AccessGrant.expiresAt` are stored but never queried. Add read filters (`?warrantyExpired=`,
   `expiringBefore=`, reorder report). Then unify into alerts under one scheduler decision (Tier 3).
7. **Knowledge base depth** (feature). Index `content` in Meili (quick win — runbook bodies are
   unsearchable today), append-only `ArticleVersion` (an edit currently destroys history — violates
   "nothing is hard-deleted"), and article↔asset/application linking (makes the KB IT-native).
8. **Query-param DTOs** (code-quality, medium). The global zod pipe validates only `@Body`; query/
   path validation is reimplemented **six inconsistent ways**. Replace with shared `@Query()` DTOs —
   auto-documents every filter in OpenAPI. Bundle with the pagination rollout (both touch every list).

---

## TIER 3 — Platform maturation (larger / sequenced)

- **AccessRequest → approval → provision** workflow (after RBAC defines approvers). The headline
  Access feature that turns a passive ledger into a self-service portal. Entity already designed in
  the domain note.
- **Access reviews / recertification** and **separation-of-duties** gating on `isCritical`.
- **Scheduler decision** (likely BullMQ + Redis ADR) — *one* decision unblocks warranty/EOL alerts,
  grant-expiry enforcement, low-stock reorder, KB staleness, **and** the deferred SEC-002 (.docx bomb
  needs a memory-budgeted worker). Verify the "one-command setup" operator cost first.
- **Integration test tier** (Testcontainers / CI Postgres) — the keystone testing investment: the
  DB-enforced invariants (double-assign 409, FK Restrict, stock race, soft-delete proxy) are tested
  **nowhere**, and a wrong migration passes the whole green suite. The lone e2e test is stale and
  silently excluded from CI.
- **CRUD base abstraction** — ~600 lines of identical controller/service skeleton across 13 modules;
  extract `findOneOr404`/`softDelete` helpers (quick win) and evaluate a `CrudService` base (ADR).
- **Frontend platform** — brand/design language (it reads as a grayscale wireframe), mobile/floor
  navigation (Sheet primitive is vendored but unused), RSC migration (ADR-0020's own deferral trigger
  is now met), optimistic updates + `keepPreviousData`.

---

## Quick wins — the fast, high-value batch (each < ~2h)

> These are safe, isolated, and mostly independent of the bigger decisions. Strong candidates for an
> immediate cleanup PR (or a few small ones).

**Correctness / contracts**
- `keepPreviousData` on the list hooks (kills skeleton flash on every filter keystroke) — one line each.
- Cross-field zod refines: `expiresAt >= grantedAt`, reject `from > to` ranges, reject empty `{}` PATCH.
- Map `P2020`→400 and slug collisions → a specific 409 (not the generic "already exists").
- Add `{userId}` to the `RELEASED` asset-history payload (disambiguates multi-owner timelines).
- Global `@ApiBearerAuth()` in `main.ts` (9 of 14 controllers wrongly show as unauthenticated in Swagger).

**Frontend / UX**
- Remove dead `/tickets` & `/settings` sidebar links and the "Open tickets" dashboard card.
- Wire the vendored `Sheet` into a `md:hidden` hamburger so the app is usable on a phone.
- One brand accent token + semantic `--success/--warning/--info` (transforms the wireframe perception).
- Add `rehype-sanitize`/DOMPurify to `MarkdownView` — **closes SEC-003 by construction**.
- Index article `content` in Meili + `reindex:all` — runbook bodies become findable.
- Add `not-found.tsx` / `global-error.tsx`; `aria-live` on results & status regions.

**Docs (truth-in-advertising — these mislead operators today)**
- `README.md:61-63` — replace the false "auth deferred / unauthenticated / must not be exposed" block
  with the real OIDC posture (bundled Zitadel, BYOI by 3 vars, `AUTH_MODE=shim` dev-only).
- `setup.md` — it no longer yields a working dev env (omits Meili, Zitadel, and the web `.env`).
- Infra docs (`deploy-self-hosted.md`, `infra/README.md`) still say "auth not implemented — do not expose".
- Mark **ADR-0016 superseded** by ADR-0037/0039; fix `.env.example` drift (missing `OIDC_JWKS_URI`,
  v4-era `NEXTAUTH_URL`).

**Infra / ops (DR is the scary one)**
- `chmod 600 infra/env/.env.prod` (currently world-readable 0644) and rotate the weak local secrets.
- Fix `backups.md`: the "cleanest restore" uses `down -v`, which **destroys the Zitadel IdP** (all 5
  volumes) — swap for targeted `docker volume rm`. Backups also cover only the app DB, not the Zitadel
  DB + `ZITADEL_MASTERKEY` → "restored the backup and nobody can log in."
- Digest-pin base images (closes the deferred ADR-0025 follow-up; `node:26-alpine` is a rolling tag).
- Add `logging:` rotation + modest `mem_limit` to compose services (single-host disk/OOM safety).
- Fix the broken first-deploy `reindex:all` command (no Bun in the Node runtime image).

---

## Decisions needed from the CEO (escalations)

1. **RBAC shape** — approve the minimal `{ADMIN, MEMBER, VIEWER}` model (my rec) vs. a richer
   scheme? This is an auth-contract change → new ADR. **Blocks** AccessRequest and access reviews.
2. **Soft-delete reuse policy** — when an entity is soft-deleted, should recreating the same
   email/slug/sku **reuse/restore** the old record or **create fresh**? Determines whether we add
   restore endpoints or just partial unique indexes.
3. **Async workers (BullMQ + Redis)** — adding Redis touches the "one-command setup" operator
   promise. It unblocks four alerting features + SEC-002. Approve adding the component, or keep
   alerts synchronous/cron-only for now?
4. **List/asset response split** — lean list projection vs. full detail needs a `shared` schema split
   (`AssetListItem` / `ArticleListItem`). Approve introducing list-vs-detail DTOs.
5. **Brand direction** — the UX fleet recommends one accent color on the neutral canvas (a PROPOSAL
   to amend ADR-0011's "neutral, not flashy"). Want to pick a direction, or keep grayscale?

---

## Doc-drift identified (correction pending CEO authorization)

The review confirmed several stale claims in the CTO references (`system-map.md`,
`decision-history.md`) — **not yet edited** (a self-modification guard blocked the change in this
read-only session; awaiting the CEO's OK): ArticleVersion is **not** in the schema; Meilisearch
**is** in the prod compose; the IdP choice (Zitadel) and frontend auth are **decided/shipped**, not
pending; the login-placeholder / shim-frontend known-debt rows are resolved. The user-facing doc
drift (README, `setup.md`, infra docs, ADR-0016 status) is listed under Quick wins for a future PR.

---

## Index of analyses

**Backend (10)** · [architecture-structure](backend-architecture-structure/analysis.md) · [bugs-correctness](backend-bugs-correctness/analysis.md) · [data-model-prisma](backend-data-model-prisma/analysis.md) · [performance-optimization](backend-performance-optimization/analysis.md) · [completeness-gaps](backend-completeness-gaps/analysis.md) · [api-contracts](backend-api-contracts/analysis.md) · [auth-authz](backend-auth-authz/analysis.md) · [testing-quality](backend-testing-quality/analysis.md) · [observability-ops](backend-observability-ops/analysis.md) · [search-subsystem](backend-search-subsystem/analysis.md)

**Product / Features (3)** · [inventory-pillar](features-inventory-pillar/analysis.md) · [access-pillar](features-access-pillar/analysis.md) · [knowledge-and-crosscutting](features-knowledge-and-crosscutting/analysis.md)

**Frontend / UX (5)** · [design-language-ia](ux-design-language-ia/analysis.md) · [dashboard-and-dataviz](ux-dashboard-and-dataviz/analysis.md) · [inventory-screens](ux-inventory-screens/analysis.md) · [access-kb-screens](ux-access-kb-screens/analysis.md) · [code-quality-perf](frontend-code-quality-perf/analysis.md)

**Infrastructure (2)** · [devops-cicd](infra-devops-cicd/analysis.md) · [ops-reliability](infra-ops-reliability/analysis.md)

**Cross-cutting (2)** · [shared-contracts-package](shared-contracts-package/analysis.md) · [docs-dx-and-drift](docs-dx-and-drift/analysis.md)

> The four reports with full long-form write-ups (extra Method / Strategic-recommendations /
> Open-questions sections) are **completeness-gaps, observability-ops, search-subsystem, ops-reliability**.
> The other 18 carry the analyst's structured digest (top findings with category/severity/effort/
> confidence/justification/location/recommendation + quick wins).
