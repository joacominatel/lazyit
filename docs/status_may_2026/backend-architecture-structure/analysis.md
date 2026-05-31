# Backend architecture, module structure, file/code organization & refactoring

> Status snapshot — **2026-05-30** (`status_may_2026`). Team: **Backend**.
> Produced by a senior-analyst pass in the CTO multi-agent review fleet. Findings below are this analyst's structured digest (top findings, highest priority first).

**Headline:** A clean, consistent NestJS codebase (no cycles, no barrels, sane global stack) whose main scaling tax is ~600 lines of identical CRUD copy-pasted across 13 modules with no shared abstraction, plus a 347-line auth guard doing DB + network I/O and no public/health route.

## Findings (10)

### 1. ~13 CRUD modules repeat the same controller+service skeleton verbatim — no shared base

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| refactor | medium | large | high |

- **Location:** `apps/api/src/asset-categories/asset-categories.service.ts:1-44 (+ application-categories, consumable-categories, article-categories, locations, asset-models, users, applications); asset-categories.controller.ts:30-67 vs locations.controller.ts:25-67`
- **Why it matters:** The findAll/findOne(404)/create/update/remove(soft-delete) shape is copied byte-for-byte across the simple modules; the findOne 404 guard appears 15+ times verbatim and the soft-delete remove in every mutable module; locations.controller and asset-categories.controller are line-for-line twins. The CEO wants lazyit to grow into a large multi-workflow platform, so every new entity (Ticket, AccessRequest, reporting) is today another ~110 lines of copy-paste a reviewer must read in full to confirm it didn't drift (e.g. dropping the findOne-before-update 404 contract or forgetting soft-delete).
- **Recommendation:** PROPOSAL: either extract a generic CrudService<TDelegate> base (entity name + Prisma delegate, soft-delete + 404 baked in) that simple services extend with orderBy/special-delete overrides, OR (lighter, immediate) extract just findOneOr404(delegate,id,name) and softDelete(delegate,id) helpers into common/. Keep relation-heavy services (assets/articles/consumables/access-grants) hand-written. Decide via ADR — see Open Question 1.

### 2. Global JwtAuthGuard injects Prisma and does network I/O — heavy guard, hard to test, mixes 4 responsibilities

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| code-quality | medium | medium | high |

- **Location:** `apps/api/src/auth/jwt-auth.guard.ts:42-302`
- **Why it matters:** The 347-line guard owns shim parsing, OIDC JWT verification, JIT user provisioning (a DB write), and OIDC discovery + userinfo enrichment (two fetch calls with X-Forwarded-* rewriting), injects PrismaService, holds mutable jwks/userinfoEndpoint cache state, and exposes resetJwks() only for tests. It is the APP_GUARD for the whole API, so this mixing makes the auth contract hard to reason about and unit-test, and RBAC (a known gap) will only pile on.
- **Recommendation:** PROPOSAL (refactor, not an ADR-0038 behavior change): keep the guard thin (extract→verify→attach request.user) and move JIT provisioning + userinfo enrichment into an injectable JitProvisioningService/OidcUserService and discovery into an OidcDiscoveryService under auth/. This also creates the seam where the future RBAC authorization guard sits beside the authentication guard.

### 3. No @Public() escape hatch and no health endpoint — root GET / and probes are all auth-gated in prod

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| infra | medium | small | high |

- **Location:** `apps/api/src/auth/jwt-auth.guard.ts:54-64; apps/api/src/app.controller.ts:4-12; whole tree (no terminus/health)`
- **Why it matters:** The guard never reads route metadata (no Reflector/@Public/SetMetadata anywhere), so in OIDC mode every route — including the liveness root GET / in app.controller.ts — returns 401 without a Bearer token, and there is no /health endpoint at all. The product mandate is one-command setup operated by an IT generalist; Docker/Caddy/orchestrator health checks need an unauthenticated liveness/readiness route, and curl against a prod API returning 401 reads like a misconfiguration, undermining the loud-actionable promise.
- **Recommendation:** PROPOSAL: add a @Public() decorator (SetMetadata) read by the guard via Reflector.getAllAndOverride, and a @Public() GET /health (liveness + DB-ping readiness). Borders infra — coordinate with the DevOps lane rather than implement unilaterally.

### 4. Query-string parsing/validation is duplicated and split three ways (incl. a duplicated parseActiveOnly)

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| code-quality | medium | medium | high |

- **Location:** `asset-assignments/active-only.ts vs access-grants/query-params.ts; assets.controller.ts:84-99; articles.controller.ts:76-94; consumables.controller.ts:94-100; common/parse-uuid-query.ts`
- **Why it matters:** parseActiveOnly exists twice with identical bodies (asset-assignments/active-only.ts and access-grants/query-params.ts) and users.controller imports both under aliases; enum status validation is hand-rolled inline in assets and articles controllers; cursor/range query validation is parsed inline too. So query handling is split between one shared util (parseUuidQuery), per-feature utils, and inline-in-controller — controllers carry input-shaping logic that is inconsistent in where it lives, a fix-one-miss-the-other trap that multiplies as list endpoints grow.
- **Recommendation:** PROPOSAL: consolidate boolean/enum/cursor parsing into common/query/ (parseBooleanFlag, a small ParseZodQueryPipe, plus the existing parseUuidQuery); delete the duplicate parseActiveOnly. Fold this into the ADR-0030 pagination rollout, which touches every list anyway.

### 5. @ApiBearerAuth() on only 5 of 14 controllers — inconsistent OpenAPI auth metadata

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| docs | low | quick-win | high |

- **Location:** `present on assets/articles/asset-assignments/access-grants/consumables; absent on users.controller.ts:38, applications.controller.ts:36, + 7 others`
- **Why it matters:** Every route is auth-gated by the global guard (ADR-0038), yet only the 5 controllers taking @CurrentUser() carry @ApiBearerAuth(); the other 9 (users, locations, asset-categories, asset-models, applications, application-categories, article-categories, consumable-categories, search) still require a Bearer token in OIDC mode but show as unauthenticated in Swagger, so the docs UI's Authorize lock doesn't apply and an operator testing POST /users gets a confusing 401. Swagger is the operator-facing API surface (ADR-0018).
- **Recommendation:** Set bearer auth globally once via DocumentBuilder().addSecurityRequirements('bearer') in main.ts and drop the per-controller decorators (the guard is global, so global metadata is correct). Quick win.

### 6. Inconsistent DTO declaration style (inline private classes vs dedicated *.dto.ts) with an undocumented OpenAPI-name rule

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| code-quality | low | small | high |

- **Location:** `inline: locations.controller.ts:25-27, assets.controller.ts:40-47, users.controller.ts:34-36; dedicated: access-grants/access-grant.dto.ts, asset-assignments/asset-assignment.dto.ts`
- **Why it matters:** Most modules declare class XDto extends createZodDto(...) inline in the controller, but access-grants and asset-assignments use a shared *.dto.ts file because their DTOs are reused by nested endpoints on other controllers (users.controller imports AccessGrantDto and AssetAssignmentDto). The reasoning is sound and documented in access-grant.dto.ts (define once or Swagger emits duplicate schemas), but two conventions for the same artifact leave a newcomer unsure which to follow and make the duplicate-schema rule easy to violate.
- **Recommendation:** PROPOSAL: document the rule in code-conventions.md — DTOs inline by default; promote to *.dto.ts only when shared across controllers; never re-declare a createZodDto class for a schema that already has one. No code change.

### 7. Nested-resource endpoints live on the parent controller, coupling modules and duplicating filter wiring

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| refactor | low | medium | medium |

- **Location:** `users.controller.ts:61-112; assets.controller.ts:111-166; applications.controller.ts:58-87; vs owner access-grants.controller.ts:59-71`
- **Why it matters:** UsersController injects AssetAssignmentsService and AccessGrantsService and re-implements their list filters; AssetsController injects AssetAssignmentsService + AssetHistoryService. The activeOnly/includeExpired parse→service call is duplicated between the owning controller and each nested host, so a change to the access-grant list contract must be made in 3 places, and it blurs the module-per-bounded-area boundary the convention prizes. Benign today (no cycles — verified, no forwardRef anywhere).
- **Recommendation:** PROPOSAL: acceptable at current scale (flag, don't fix). If nested-endpoint count grows, push filter-and-list logic fully into the owning service (findForUser(userId, flags)) so the parent controller calls one method, or adopt Nest sub-resource routing.

### 8. PrismaService returns a Proxy from its constructor — clever but opaque, latent upgrade risk

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| code-quality | low | small | medium |

- **Location:** `apps/api/src/prisma/prisma.service.ts:44-56`
- **Why it matters:** The constructor builds a $extends-ed soft-delete client and returns a Proxy over `this` that routes model access and $-methods to the extended client while keeping lifecycle on the base (a deliberate ADR-0032 solution to $extends returning a new object). It is correct and well-commented, but constructor-returns-a-Proxy with prop-in-ext/Reflect.get branching is unusual and is the kind of thing that silently breaks on a Prisma major upgrade — and this is the data layer for the whole app (blast radius = everything).
- **Recommendation:** PROPOSAL: keep it (right call for ADR-0032) but ensure soft-delete.extension.spec covers the Proxy routing for lifecycle vs model vs $transaction paths, and pin the Prisma minor in CI so upgrades are deliberate, tested events. No ADR change.

### 9. AppModule import list is hand-curated for timing; four @Global modules hide cross-cutting deps; no pillar grouping

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| code-quality | low | small | medium |

- **Location:** `apps/api/src/app.module.ts:30-56`
- **Why it matters:** imports[] is ordered with intent in comments, but since Prisma/Common/Search/Auth are @Global most ordering is cosmetic (only LoggerModule.forRoot is order-sensitive), which invites a contributor to assume false dependencies. Four global modules means four invisible cross-cutting dependencies absent from any feature module's imports, and the flat list of 15+ feature modules does not express the three-pillar boundary in code.
- **Recommendation:** PROPOSAL: group imports into commented infra-vs-feature sections and note only LoggerModule ordering matters. As modules pass ~20, introduce InventoryModule/AccessModule/KnowledgeModule aggregators so AppModule imports 3-4 pillars + infra and scope-creep becomes a structural question.

### 10. No documented feature-module anatomy — every new module is reverse-engineered from an existing one

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| docs | low | small | medium |

- **Location:** `docs/04-development/code-conventions.md (Backend section); de facto template in apps/api/src/locations/`
- **Why it matters:** The codebase has a strong de facto module template (proven by how identical the 13 modules are) but it is nowhere written down — the backend section of code-conventions.md is 6 bullets that say nothing about the controller/service/dto/module file shape, the findOne-before-update/remove 404 contract, or the soft-delete remove. New contributors (human or agent) reverse-engineer it from locations/. The cheapest way to keep 30+ future modules consistent is a one-page anatomy reference plus ideally a generator.
- **Recommendation:** PROPOSAL: add a Feature module anatomy section to code-conventions.md (file layout, the 404 contract, soft-delete remove, the DTO rule, the actor/@CurrentUser pattern). If the finding-1 base class is adopted, document it here; optionally ship a nest-g generator.

## Quick wins

- Set Swagger bearer auth globally in main.ts (DocumentBuilder().addSecurityRequirements('bearer')) and delete the 5 scattered @ApiBearerAuth() decorators so all 14 controllers show as protected (~20 min).
- Delete the duplicated asset-assignments/active-only.ts parseActiveOnly and point both call sites at the one copy (or move both to common/) to kill the fix-one-miss-the-other trap (~20 min).
- Extract findOneOr404(delegate,id,name) and softDelete(delegate,id) pure helpers into common/ and reuse them in the 15+ identical 404 guards and soft-delete bodies — dedup without committing to a base class (~1-1.5 h).
- Add a @Public() decorator (Reflector-read) plus a GET /health liveness/readiness route to unblock container health checks — coordinate with DevOps lane (~1 h).
- Document the feature-module anatomy and the inline-vs-shared DTO rule in code-conventions.md (~45 min).

---

_Note: this document was materialized from the analyst's structured digest. The four analyses with full long-form write-ups on disk (backend-completeness-gaps, backend-observability-ops, backend-search-subsystem, infra-ops-reliability) include extra Method / Strategic-recommendations / Open-questions sections; the rest carry the digest above._
