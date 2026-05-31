# Backend Completeness — what is missing to make lazyit a finished, large IT platform
> as of 2026-05-30 (status_may_2026)

## Role & scope

I am the Senior Backend Product Engineer doing the headline backend completeness pass: map exactly
what is built vs the domain model and the product vision, then propose the prioritized path to
"finished + large" — the unbuilt entities (Tickets/TicketComment, AccessRequest, ArticleVersion),
the missing RBAC/roles/permissions model, dashboard/metrics, audit-log surfacing, bulk import/export,
notifications, scheduled jobs, and reporting. Read-only pass.

Not a security sweep (Sentinel's lane — SEC-002/003/007 are built upon, not re-litigated) and not an
infra pass (DevOps' lane). It is product/engineering completeness for a backend the CTO explicitly
calls unfinished, with the CEO's mandate that lazyit grow into a large, easy platform letting a 2-20
person IT team run all their workflows in one app — without violating the three-pillar discipline
(Inventory / Access / Knowledge) or the anti-goals (not a ticketing system as a pillar, not
monitoring, not HR, not enterprise, no lock-in).

## Method

I read, in full or in the relevant parts:

- `apps/api/prisma/schema.prisma` (all 482 lines) — the authoritative model.
- `apps/api/src/app.module.ts` — the 18 registered modules.
- `apps/api/src/auth/jwt-auth.guard.ts` + `auth/current-user.decorator.ts` — the entire auth surface.
- Representative services: `access-grants/access-grants.service.ts`, `articles/articles.service.ts`,
  `consumables/consumables.service.ts`, `asset-history/asset-history.service.ts`,
  `users/users.service.ts`.
- `access-grants/access-grants.controller.ts`, the users/asset-assignments controller endpoint lists.
- `apps/web/app/(app)/dashboard/page.tsx` (the placeholder).
- Domain notes: `docs/02-domain/_MOC.md`, `entities/ticket.md`, `ticket-comment.md`,
  `access-request.md`, `article-version.md`; `docs/00-overview/vision.md`.
- ADRs: 0016, 0021, 0023, 0030, 0033, 0034, 0038, 0039.
- `.claude/skills/lazyit-cto/references/system-map.md`.
- Repo-wide greps for `role|permission|rbac`, `schedule|cron|bullmq`, `csv|export`,
  `notification|webhook|smtp`, `count|groupBy|aggregate`, and a PageQuery/Page<T> contract.

Backend is ~4,617 LOC of non-test `.ts` under `apps/api/src`, 18 modules, 11 migrations.

FACT = verified in code/schema I read. PROPOSAL/OPINION = my recommendation.

---

## Findings

Ordered by priority for the stated mission (a small IT team running all workflows in one app).

### 1. No RBAC / roles / permissions — every authenticated user is equal, including over the Access pillar

- Category: security / feature
- Severity: critical
- Effort: large
- Confidence: high
- Location: `apps/api/prisma/schema.prisma:19-53` (User has no role field);
  `apps/api/src/auth/jwt-auth.guard.ts:140-211` (JIT-provisions every IdP user as a full, equal User);
  `apps/api/src/access-grants/access-grants.controller.ts:38-123` (no authz on read or write);
  `docs/03-decisions/0023-access-management-design.md:115-117`.
- Observation (FACT): There is no `Role`, `Permission`, or even an `isAdmin` boolean anywhere — grep
  for `role|permission|rbac|isAdmin|@Roles` across `apps/api/src`, `packages/shared/src`, `prisma`
  returns no model and no guard. The only app-level authorization is in ArticlesService (DRAFT privacy
  + author-only writes — `articles.service.ts:259-289`). Every other module is wide open to any
  authenticated user. ADR-0023:115-117 itself says "There is no authorization on reads or writes yet —
  anyone can grant/revoke. This is acceptable only for the pre-auth MVP." That caveat is now stale and
  dangerous: auth has landed (OIDC, ADR-0038), so this is no longer pre-auth — it is production with no
  authorization. ADR-0038:112-114,127 makes the trust model explicit: "the IdP is fully trusted...
  lazyit does not add a second gate." In practice: any person the IdP admin gives any account to can
  read every access grant (`GET /access-grants` dumps who-can-access-what across all SaaS/infra), grant
  themselves admin access to production applications, revoke others' access, and delete any
  asset/article/consumable.
- Why it matters: The Access pillar's whole value is auditable control of who can access what, including
  sensitive production infra (`Application.isCritical`, `schema.prisma:347`). A tool holding that data
  but letting every logged-in user mutate it is not "ServiceNow-grade." The IT team (2-20) needs to be
  distinguishable from the employees whose access they manage. Single biggest blocker to "finished."
- Recommendation (PROPOSAL): Minimal, opinionated RBAC — resist the enterprise permission-matrix
  anti-goal. (1) Add `User.role` enum `{ ADMIN, MEMBER, VIEWER }` (default MEMBER; first-provisioned
  user → ADMIN, or seed an admin). (2) A `@Roles()` decorator + `RolesGuard` composing after
  JwtAuthGuard; gate Access writes (grant/revoke), Users, and destructive deletes to ADMIN; Access reads
  to ADMIN/MEMBER; VIEWER read-only. (3) Operationalize ADR-0038's already-sketched "Admin approval
  mode" (line 144). This is a PROPOSAL to extend ADR-0023/0038 (which defer authz to "when auth lands" —
  it has), not to supersede them.

### 2. Offboarding leaves a departed user holding live access grants and asset assignments

- Category: feature / bug
- Severity: high
- Effort: small
- Confidence: high
- Location: `apps/api/src/users/users.service.ts:46-56` (`remove` = bare soft delete).
- Observation (FACT): `DELETE /users/:id` only sets `deletedAt` and drops the search doc. It does NOT
  release the user's active AssetAssignments (`releasedAt` stays null) or revoke their active
  AccessGrants (`revokedAt` stays null). The append-only joins use FK Restrict, but soft delete is an
  UPDATE so Restrict never fires (schema comments at `schema.prisma:182-184`, `370-372`). ADR-0023:110-114
  flags exactly this: a grant can end up pointing at a soft-deleted user, and "a soft-delete-time guard
  could be added later." It has not been.
- Why it matters: Offboarding is the #1 recurring IT workflow and the original justification for the
  asset-centric, append-only design. Today, when an employee leaves, lazyit marks them deleted but their
  laptop still shows as assigned to them and they still hold active grants on every application — exactly
  the audit failure the Access pillar exists to prevent. "Who can access AWS" still returns the departed
  user.
- Recommendation (PROPOSAL): On user soft-delete, in one transaction, close all active assignments
  (`releasedAt = now`, `releasedById = actor`) and revoke all active grants (`revokedAt = now`,
  `revokedById = actor`), emitting AssetHistory.RELEASED events. Optionally a richer
  `POST /users/:id/offboard` returning the reclaimed assets + revoked grants. Small, high-leverage,
  strengthens both Inventory and Access.

### 3. Dashboard / metrics: no aggregation endpoint; the screen is a hardcoded placeholder

- Category: feature
- Severity: high
- Effort: medium
- Confidence: high
- Location: `apps/web/app/(app)/dashboard/page.tsx:9-34` (STATS hardcoded to ["Assets","Open
  tickets","Users"], every value renders `—`); no dashboard/metrics module in `app.module.ts`; grep for
  `count|groupBy|aggregate` finds only an internal soft-delete-extension use, never a stats endpoint.
- Observation (FACT): No `GET /dashboard` or `/metrics` endpoint and no Prisma aggregation in any
  service. The dashboard even advertises an "Open tickets" tile for a Ticket entity that does not exist.
  The data to power a real dashboard is all present (asset count by status, low-stock via
  `consumables.service.ts:42-52`, active grants, warranty expiries, draft vs published articles).
- Why it matters: "Overview of your IT estate" is the daily landing screen; a dead placeholder undercuts
  the "modern, opinionated" positioning. A metrics endpoint is also the natural home for the
  informative-only signals the schema models but never surfaces (warranty, low stock, expiring grants —
  finding 7).
- Recommendation (PROPOSAL): A small DashboardModule with `GET /dashboard/summary` returning
  counts/aggregates across the three pillars via `prisma.*.count()` + `groupBy`. Pure read, no new
  tables. Response shape in `@lazyit/shared`.

### 4. AccessRequest (request → approve → provision) is unbuilt — access is admin-push only

- Category: feature
- Severity: high
- Effort: large
- Confidence: high
- Location: `docs/02-domain/entities/access-request.md:13-19` (planned, "Explicitly deferred"); not in
  `schema.prisma`; not a module; ADR-0023:119-123 (deferred).
- Observation (FACT): Access is created directly by whoever calls `POST /access-grants`
  (`access-grants.service.ts:78-99`). No request/approval workflow, no AccessRequest table. The domain
  note and ADR-0023 describe the intended non-destructive shape: a new table that produces an
  AccessGrant on approval, with an approver concept.
- Why it matters: For a team optimizing all their workflows, "employee requests access, IT admin
  approves, a grant is auto-created with full audit trail" is the canonical Access workflow and the thing
  that makes lazyit a self-service portal rather than a spreadsheet the IT team edits by hand. Highest-
  value new entity. Depends on RBAC (finding 1) to define who can approve.
- Recommendation (PROPOSAL): Build after RBAC. `AccessRequest { userId, applicationId,
  requestedAccessLevel?, justification?, status (REQUESTED|APPROVED|REJECTED), reviewedById?,
  reviewedAt?, resultingGrantId? }`, cuid, soft-deletable. On approve, transactionally create the
  AccessGrant and link it. Explicitly the deferred-but-planned design — needs an implementation ADR, not
  a supersession.

### 5. Pagination contract (ADR-0030) is defined on paper but not even typed in @lazyit/shared, and no list endpoint implements it

- Category: infra / optimization
- Severity: medium (high as data grows)
- Effort: medium
- Confidence: high
- Location: `docs/03-decisions/0030-list-pagination-contract.md` (contract: PageQuery, Page<T>, default
  50 / max 200); grep for `PageQuery|Page<|pagination|limit.*offset` in `packages/shared/src` returns
  nothing; every list service (`access-grants.service.ts:43-61`, `consumables.service.ts:42-52`,
  `articles.service.ts:61-79`, etc.) returns an unbounded findMany.
- Observation (FACT): ADR-0030 decided an offset/limit contract and named `GET /access-grants` as the
  first migration target. The contract types do not exist in shared yet, so even new endpoints can't
  "inherit" them. Overlaps SEC-007 (Sentinel) but is also a plain completeness gap: a large platform
  cannot ship unbounded list responses.
- Why it matters: Every new entity (AccessRequest, Tickets) and the audit-log surfacing (finding 6) will
  need lists. Typing the contract once now (cheap) prevents N endpoints each inventing their own paging.
- Recommendation (PROPOSAL): Add PageQuery/Page<T> zod schemas + types to `@lazyit/shared` (a quick win
  on its own). Then migrate `GET /access-grants` first per the ADR, and make all new list endpoints
  page-aware from day one. Coordinate the frontend data-layer change (ADR-0020) as a separate subagent.

### 6. No audit-log surfacing: AssetHistory has no controller, no cross-entity activity feed

- Category: feature
- Severity: medium
- Effort: medium
- Confidence: high
- Location: `apps/api/src/asset-history/` (module + service only — no controller, confirmed by ls);
  `asset-history.service.ts:52-62` (`list` is per-asset only, reached via `GET /assets/:id/history`);
  `consumables.service.ts:144-162` (movements listed only per-consumable).
- Observation (FACT): Four append-only audit trails exist (AssetHistory, AssetAssignment, AccessGrant,
  ConsumableMovement) — auditability is a first principle (vision.md:48-50) — yet there is no endpoint to
  view them across entities. AssetHistory is readable only nested under one asset; no "what happened this
  week" feed, no global audit view. Data captured but invisible.
- Why it matters: "Auditability by default" is meaningless if the trail can't be read. For an IT team
  "what changed, by whom, when" is a core daily question (incident review, offboarding verification,
  change tracking). Low-risk to build (reads over existing append-only tables), high-value.
- Recommendation (PROPOSAL): An AuditModule exposing paginated, filterable reads of the access-grant
  timeline and a unified activity feed (union of the four logs, or at minimum cross-entity AssetHistory +
  AccessGrant). Depends on the pagination contract (finding 5). Stays inside the three pillars.

### 7. Scheduled jobs entirely absent: warranty expiry, low-stock, grant-expiry all informative-only

- Category: feature / infra
- Severity: medium
- Effort: large
- Confidence: high
- Location: grep for `schedule|cron|bullmq|@nestjs/schedule|setInterval` in `apps/api/src` and
  `package.json` returns nothing; `schema.prisma:143-144` (`warrantyEnd`), `:382-383`
  (`AccessGrant.expiresAt`, comment: "Informative only — no scheduler auto-revokes"), `:436-437`
  (`Consumable.minStock`); `consumables.service.ts:42-52` (low-stock is a query, never a push).
- Observation (FACT): Three time-based signals are modeled but purely passive: warranty end, grant
  expiry, low-stock threshold. ADR-0023:124-127 defers an auto-revoke scheduler; ADR-0034 makes minStock
  a query filter only. No scheduler, no worker, no cron. System-map lists "Async workers: BullMQ + Redis"
  as a pending major decision.
- Why it matters: A proactive IT tool tells the team "this warranty expires in 30 days," "this consumable
  is below reorder," "this grant expired yesterday." Today the operator must remember to run a filter.
  Core to "optimize all workflows." But pulls in the BullMQ/Redis decision (ADR-0009 tension) and overlaps
  SEC-002's deferral — a larger bet.
- Recommendation (PROPOSAL, sequenced): Start with the cheapest useful slice — a metrics/dashboard
  endpoint (finding 3) that computes "expiring soon / low stock / expired grants" on read, ~80% of the
  value with zero scheduling infra. Defer true scheduled jobs + notifications until the BullMQ/Redis ADR
  is settled (also unblocks SEC-002). Do NOT auto-revoke grants on expiry without an explicit ADR —
  ADR-0023 deliberately makes expiry informative.

### 8. Notifications / outbound delivery: no email, no webhooks, no notification model

- Category: feature / infra
- Severity: medium
- Effort: large
- Confidence: high
- Location: grep for `notification|webhook|smtp|nodemailer|email.*send` in `apps/api/src` returns
  nothing.
- Observation (FACT): No notification entity, no outbound channel, no in-app notification feed. Listed
  under "NOT built." Natural consumer of scheduled jobs (finding 7 — low-stock alert) and AccessRequest
  (finding 4 — "your request was approved").
- Why it matters: Workflows in one app eventually need to reach out, but must stay self-hosted with no
  phone-home / no mandatory cloud (anti-goal). Downstream of having something to say (findings 4, 7) —
  sequences last.
- Recommendation (PROPOSAL): Defer until AccessRequest + scheduled jobs exist. Start with an in-app
  Notification table (read inside the app — no external dependency, respects no-phone-home) and make
  SMTP/webhook delivery an optional, operator-configured channel. Needs its own ADR (pairs with the
  deferred "Settings backend" pending decision).

### 9. Bulk import / export (CSV): none exists; only the single-file .docx KB import is built

- Category: feature
- Severity: medium
- Effort: medium
- Confidence: high
- Location: grep for `csv|export|text/csv` in `apps/api/src` returns nothing; the only import surface is
  `articles.service.ts:200-241` (one .docx/.md file → one article).
- Observation (FACT): No CSV (or any) bulk import for assets/users/consumables, and no export endpoint
  for any entity. A new lazyit instance has no way to onboard an existing inventory except one record at
  a time through the UI.
- Why it matters: (a) Export is a stated guardrail — "NO vendor lock-in (everything exportable)"; today
  nothing is exportable via the API beyond per-entity reads. (b) Bulk asset/user import is the table-
  stakes migration path for any adopting team (Snipe-IT/GLPI all have it). Both strengthen the Inventory
  pillar and adoption.
- Recommendation (PROPOSAL): Export first (cheaper, a guardrail commitment): `GET /<entity>?format=csv`
  or `/export` for assets/users/consumables/grants. Then a bulk-import endpoint (CSV → validated rows →
  batch create, with a dry-run/validation mode) using existing `@lazyit/shared` zod schemas. Bulk import
  is a decompression/DoS surface (coordinate with Sentinel) and likely wants async-worker infra for large
  files.

### 10. Tickets + TicketComment: planned in the ERD but deliberately a FUTURE option, not a pillar

- Category: feature
- Severity: low (info / scope-guard)
- Effort: large
- Confidence: high
- Location: `docs/02-domain/_MOC.md:28-30,52` + `entities/ticket.md`, `ticket-comment.md` (both "⚪
  planned, order 4"); not in `schema.prisma`; not a module. CTO context: "NOT a ticketing system (tickets
  are a FUTURE option, not a pillar)."
- Observation (FACT): Tickets/TicketComment appear in the conceptual ERD and the build order (order 4)
  but are unbuilt, and the product framing says tickets are not a pillar and build on top of the three
  pillars. The dashboard placeholder's "Open tickets" tile (finding 3) is the only trace, and it is
  premature.
- Why it matters: Biggest single chunk of the original build order that is unbuilt, so it looks like "the
  obvious next thing." It is a scope-discipline trap: building full ticketing now risks drifting toward "a
  ticketing tool bent into shape" — the anti-positioning in vision.md:28-30. The three pillars and their
  workflows (offboarding, access requests, audit, dashboard) deliver more value per unit effort.
- Recommendation (OPINION): Deprioritize. Do not build Tickets until the three pillars are finished
  (RBAC, AccessRequest, offboarding, dashboard, audit surfacing, export). When it lands, scope it as
  asset/access-linked work items (ticket references an asset/grant — the cross-cutting glue the ERD
  describes), not a general ITIL engine. Meanwhile remove the "Open tickets" tile from the dashboard
  placeholder.

### 11. ArticleVersion is documented as deferred-but-planned; the CTO system-map wrongly claims it exists (doc drift)

- Category: docs / code-quality
- Severity: low
- Effort: quick-win
- Confidence: high
- Location: `.claude/skills/lazyit-cto/references/system-map.md:55` (claims "ArticlesModule … Article +
  ArticleVersion (via service)") vs reality: `schema.prisma` has no ArticleVersion model,
  `articles.service.ts` overwrites content in place (`:139-148`), and `entities/article-version.md:13`
  marks it "Explicitly deferred." ADR-0021 ships the KB without versioning.
- Observation (FACT): The CTO's system-map asserts ArticleVersion is implemented "via service." It is
  not — no model, no table, no version rows; an article edit is a destructive in-place update. Doc drift
  that could mislead future planning ("we already have KB versioning, skip it").
- Why it matters: The system-map is "the first reference loaded at every CTO session." A false positive
  propagates into planning. ArticleVersion itself is a low-priority, non-destructive future add (a new FK
  table), correctly deferred by ADR-0021 — fine to leave unbuilt, but the map must say so.
- Recommendation: Correct the system-map line to "Article (no versioning — ADR-0021; ArticleVersion
  deferred)." (Doc fix only — flagged for the CTO; not in my write-lane to edit other files.)

### 12. Application.metadata / Asset.specs / Article.metadata jsonb is accepted but unvalidated — a quietly growing debt as the platform scales

- Category: code-quality
- Severity: low
- Effort: medium
- Confidence: medium
- Location: `schema.prisma:139-141` (Asset.specs), `:294` (Article.metadata), `:349-350`
  (Application.metadata); ADR-0007 (jsonb-by-design); ADR-0023:128-129 ("metadata validation" open
  follow-up).
- Observation (FACT): Per ADR-0007 these are intentionally flexible jsonb, "validated in the app by zod,
  not the DB." But the create/update paths pass them straight through as `Prisma.InputJsonValue`
  (`articles.service.ts:120-122`, access-grants etc.) with no zod schema actually enforcing structure —
  strictObject validates the envelope, not the jsonb contents. As more code reads these blobs (dashboard,
  search, export), unvalidated shapes become a correctness/typing hazard.
- Why it matters: Accepted debt (ADR-0007), not a violation — but "finished + large" means the flexible
  fields need at least per-asset-category spec schemas so the data stays trustworthy. Low urgency, worth a
  tracked plan so it doesn't ossify.
- Recommendation (OPINION): Keep jsonb (don't supersede ADR-0007), but add optional, category-keyed zod
  spec schemas in `@lazyit/shared` validated at the boundary when a category declares one. Defer until
  after the higher-priority findings; flag as known debt.

---

## Quick wins (high-value, < ~2 hours each)

- Type the pagination contract in `@lazyit/shared` (finding 5): add PageQuery + Page<T> zod schemas/types
  so ADR-0030 is real and new endpoints inherit it. No endpoint migration required yet.
- Fix the system-map ArticleVersion claim (finding 11): one-line correction; prevents planning off a
  false "we have KB versioning." (CTO doc-lane.)
- Remove the "Open tickets" tile from the dashboard placeholder (finding 10): it advertises a
  non-existent, intentionally-deferred entity on the landing screen. (Frontend-lane.)
- Add a `GET /dashboard/summary` skeleton returning live counts (finding 3): asset count by status, user
  count, active-grant count, low-stock count — pure reads, no schema change, replaces the `—` placeholders
  with real numbers immediately.

## Strategic recommendations (bigger bets, with sequencing)

Mission: finish the three pillars first, then grow. Suggested order (dependencies in parentheses):

1. RBAC (finding 1) — do first. Everything authorization-shaped depends on it (who approves a request,
   who revokes access, who offboards). Minimal three-role model; operationalize ADR-0038's planned "admin
   approval mode." Blocks: AccessRequest, audit-write gating.
2. Offboarding cascade (finding 2) — fast follow. Small, transactional, closes the biggest live audit
   hole. (depends on: actor from @CurrentUser — already exists.)
3. Dashboard/metrics endpoint (finding 3) + compute-on-read expiry/low-stock signals (finding 7 cheap
   slice). Turns passive schema fields into visible operator value with zero new infra.
4. Pagination contract made real + migrate GET /access-grants (finding 5). Unblocks every list that
   follows. (coordinate frontend data-layer as a separate subagent.)
5. Audit-log surfacing (finding 6). Read-only over existing append-only tables; makes "auditability by
   default" usable. (depends on: pagination.)
6. AccessRequest approval workflow (finding 4). Flagship new Access workflow. (depends on: RBAC.)
7. Export (CSV) (finding 9, export half). Honors the no-lock-in guardrail; cheap, adoption-critical.
8. Async-worker decision (BullMQ/Redis ADR) → scheduled jobs (finding 7) → notifications (finding 8) →
   bulk CSV import (finding 9, import half). All gated on settling worker infra (also unblocks SEC-002).
   The "proactive platform" tier.
9. Tickets (finding 10) — last, and only as asset/access-linked work items. Guard against drifting into a
   generic ticketing engine.
10. ArticleVersion (finding 11) and jsonb spec validation (finding 12) — opportunistic, low priority.

## Open questions for the CTO/CEO

1. RBAC shape: Is a three-role { ADMIN, MEMBER, VIEWER } model the right altitude, or does the target
   customer need per-pillar or per-application scoping? (I recommend three roles — anti-enterprise
   discipline argues against a permission matrix.)
2. First-admin bootstrap: When RBAC lands, how is the first ADMIN designated — first-provisioned user
   auto-promoted, a seed/env-configured admin email, or USER_PROVISIONING_MODE=manual (ADR-0038:144)?
   Security-sensitive default.
3. Async-worker infra (BullMQ + Redis): a pending major decision and the gate for scheduled jobs,
   notifications, large bulk import, and SEC-002. Commit now, given the ADR-0009 Bun-scope tension?
4. Grant-expiry behavior: ADR-0023 makes expiresAt informative-only. Do we ever want a job that
   auto-revokes on expiry, or only one that notifies? Auto-revoke needs a deliberate ADR supersession.
5. Tickets: Confirm tickets stay deferred until the three pillars are finished, and that when built they
   are asset/access-linked work items rather than a general ticketing system.
6. AccessRequest vs Ticket: The domain notes flag a possible overlap (access-request.md:37-39,
   ticket.md:32-36). Distinct entity or ticket subtype? I recommend distinct (specialized
   request→approve→grant workflow), but it's a design decision you own.
