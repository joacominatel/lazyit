# API design consistency, REST semantics, DTO/zod contracts, OpenAPI

> Status snapshot — **2026-05-30** (`status_may_2026`). Team: **Backend**.
> Produced by a senior-analyst pass in the CTO multi-agent review fleet. Findings below are this analyst's structured digest (top findings, highest priority first).

**Headline:** The REST surface is clean and zod-typed for bodies, but query/path validation is reimplemented six ways per-controller, OpenAPI under-documents auth/errors, the ADR-0030 pagination contract isn't even written yet, and there's no API prefix or versioning seam — fixable now while there's one consumer.

## Findings (10)

### 1. Global ZodValidationPipe validates ONLY @Body() — every query/path param is hand-validated, six inconsistent ways

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| code-quality | high | medium | high |

- **Location:** `apps/api/src/common/parse-uuid-query.ts:6-23; assets.controller.ts:78-100,153-166; articles.controller.ts:69-95; access-grants.controller.ts:59-71; search.controller.ts:59-77`
- **Why it matters:** nestjs-zod's global pipe binds only to createZodDto @Body params; the parse-uuid-query.ts comment states query strings are otherwise unchecked. Query validation is reimplemented per-controller (parseUuidQuery, inline safeParse, bespoke boolean helpers, clamped parseLimit) and several cuid filters (categoryId/locationId/assetId/applicationId) aren't validated at all, relying on the P2023/P2003->400 Prisma net. This is the biggest source of contract drift and means OpenAPI doesn't describe most filters.
- **Recommendation:** Standardize on per-endpoint query DTOs (createZodDto bound to @Query() objects) defined in @lazyit/shared, deleting parseUuidQuery, the inline safeParse blocks and the boolean helpers; this auto-documents every filter in OpenAPI. Bundle with the pagination rollout since both touch every findAll.

### 2. Pagination (ADR-0030) fully unimplemented — PageQuery/Page<T> contract not even written in @lazyit/shared

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | medium | large | high |

- **Location:** `ADR-0030; packages/shared/src (PageQuery absent); access-grants.controller.ts:59-71; asset-history.ts:41-44; search.controller.ts:10-12`
- **Why it matters:** ADR-0030 decided offset/limit (default 50, max 200, Page<T>={items,total,limit,offset}) but deferred implementation; grep confirms no PageQuery/Page in shared. Every findAll returns all rows (SEC-007: unbounded GET /access-grants can dump every grant). Meanwhile two divergent ad hoc styles already exist: asset-history cursor (before+limit) and search clamped-limit — three pagination styles, zero of the decided one. A scaling cliff as the CEO grows lazyit to 200-person companies.
- **Recommendation:** Ship PageQuerySchema + pageOf() helper in shared (quick win), then roll out offset pagination starting with GET /access-grants per the ADR. Amend ADR-0030 to reconcile the existing cursor (asset-history) and clamped-limit (search) variants as sanctioned exceptions. Do the front+back split the ADR mandates.

### 3. @ApiBearerAuth() on only 5 of 14 controllers although the auth guard is global — OpenAPI lies about auth

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| docs | medium | quick-win | high |

- **Location:** `main.ts:37 (addBearerAuth); grep over apps/api/src/**/*.controller.ts (9 controllers missing the decorator)`
- **Why it matters:** JwtAuthGuard runs on every request (hard 401 in OIDC mode), but only assets/asset-assignments/access-grants/articles/consumables carry @ApiBearerAuth(); users, locations, all categories, applications and search render in Swagger as unauthenticated. The generated OpenAPI is the contract for the frontend and future integrators — telling them GET /locations is open while it 401s is a correctness bug and masks the real auth surface.
- **Recommendation:** Apply @ApiBearerAuth() globally via DocumentBuilder + document post-processing so it can't drift, and document the AUTH_MODE=shim dev exception in the API description.

### 4. Error-response contract exists at runtime but is undocumented in OpenAPI — no 400/401/404/409 schemas, no X-Request-Id

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| docs | medium | small | high |

- **Location:** `common/prisma-exception.filter.ts:23-60; all-exceptions.filter.ts:32-43; main.ts:24 (X-Request-Id)`
- **Why it matters:** The API has a real error contract (nestjs-zod {statusCode,message,errors[]}; Prisma P2002->409/P2003,P2023->400/P2025->404; X-Request-Id exposed for error UX) but OpenAPI documents none of it — only @ApiConflictResponse appears in 4 places. The frontend error-UX work and any integrator must reverse-engineer the error shape, contradicting the 'loud actionable errors' promise.
- **Recommendation:** Define ApiErrorSchema in @lazyit/shared matching the emitted body, add a reusable @ApiStandardErrors() composite decorator, and document the X-Request-Id response header in OpenAPI.

### 5. No API version prefix and no setGlobalPrefix — resources at root, docs at /api/docs

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| infra | medium | small | high |

- **Location:** `main.ts (no setGlobalPrefix/enableVersioning); @Controller('users') mounts at /users; Swagger at api/docs (main.ts:40)`
- **Why it matters:** Routes are unversioned/unprefixed (/users, /assets) while docs live under /api; no enableVersioning anywhere. With the CEO targeting a large platform, there is no seam to evolve the contract without breaking clients — and the first breaking change (DELETE semantics, pagination envelope) has nowhere to live. Far cheaper to add now with one consumer (the web app) than after integrators exist.
- **Recommendation:** Small ADR: adopt a global /api prefix and URI versioning (/api/v1) via enableVersioning, landing before the query-DTO/pagination sweep so those ship under v1. Coordinate the base-URL change with the frontend data layer (ADR-0020).

### 6. Soft-delete DELETE returns the entity with 200 and is non-idempotent

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| refactor | medium | small | high |

- **Location:** `users.controller.ts:128-133; assets.controller.ts:186-191; applications.controller.ts:103-108; article-categories.controller.ts:68-76`
- **Why it matters:** DELETE /<resource>/:id returns the full soft-deleted row with 200 (Nest default), and a second DELETE behaves differently (404 via the soft-delete extension), so DELETE isn't idempotent per RFC 9110. For a product whose philosophy is auditability/soft-delete, the delete semantics should be deliberate, not incidental to Nest defaults; returning deletedAt-bearing entities on delete is also an unusual contract.
- **Recommendation:** Decide once (ADR-worthy): keep 200+entity for the append-only close-actions (/revoke,/release) but move plain resource DELETE to idempotent 204 (repeat delete = no-op 204), and document the chosen body shape so OpenAPI is truthful.

### 7. Boolean query-param conventions inconsistent (activeOnly vs lowStock)

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| code-quality | low | quick-win | high |

- **Location:** `access-grants/query-params.ts:10-21 vs consumables.controller.ts:58`
- **Why it matters:** activeOnly/includeExpired use value!=='false' (default true; bare ?activeOnly and ?activeOnly=1 are true) while lowStock uses ==='true' (default false; only literal 'true' is true). Inconsistent truthiness across the API is a footgun for the frontend and erodes a predictable contract.
- **Recommendation:** Standardize on one boolean coercion (a single parseBoolQuery helper or z.stringbool inside the query DTOs) and document accepted truthy/falsy literals once.

### 8. GET /search has no response DTO / @ApiOkResponse despite SearchResultsSchema existing

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| docs | low | quick-win | high |

- **Location:** `search/search.controller.ts:19-51; packages/shared/src/schemas/search.ts:86-96`
- **Why it matters:** Every other read documents its response with @ApiOkResponse({type}); search returns Promise<SearchResults> with no response DTO, so OpenAPI shows an untyped 200 — even though SearchResultsSchema is already in @lazyit/shared and could back a createZodDto. Leaves the cross-pillar search UI surface undocumented and breaks the 'every response is a zod DTO' convention.
- **Recommendation:** Add class SearchResultsDto extends createZodDto(SearchResultsSchema) {} and decorate the route with @ApiOkResponse({ type: SearchResultsDto }).

### 9. PATCH bodies accept empty {} as a silent no-op update

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| code-quality | low | quick-win | high |

- **Location:** `user.ts:40-47; location.ts:52-61; asset.ts:62-75; application.ts:86-97; consumable.ts:48-58`
- **Why it matters:** All Update*Schemas are z.strictObject({...}).partial() with no min-one-key refine, so PATCH with {} validates, runs an empty Prisma update, bumps updatedAt and returns 200 — semantically muddy and slightly pollutes the audit timeline the product values.
- **Recommendation:** Add a shared .refine(v=>Object.keys(v).length>0,'Provide at least one field to update') to the partial update schemas (or a partialUpdate(schema) helper). Low priority; bundle with the next shared-schema touch.

### 10. ParseUUIDPipe on path params used only by users — cuid :id params have no edge format check

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| code-quality | low | small | high |

- **Location:** `users.controller.ts:57,73,102,124,131 vs bare @Param('id') in all other controllers`
- **Why it matters:** User ids are uuid and use ParseUUIDPipe (clean 400). All other entities (cuid) pass raw :id to Prisma and rely on the P2023->400/P2025->404 net, yielding a generic 'Invalid input format' or 404 rather than a precise edge error — inconsistent error shape and validation happening at the DB instead of the edge (SEC-004 mitigated, not eliminated).
- **Recommendation:** Add a tiny ParseCuidPipe (z.cuid()-based) for cuid :id params mirroring the uuid case, or fold path-param validation into the query-DTO standardization effort.

## Quick wins

- Apply @ApiBearerAuth() globally in main.ts (DocumentBuilder + document post-processing) so OpenAPI stops showing 9 controllers as unauthenticated
- Add @ApiOkResponse({ type: SearchResultsDto }) to GET /search using the already-existing SearchResultsSchema
- Write PageQuerySchema + pageOf() helper in @lazyit/shared (no endpoint wiring yet) to deliver the deferred ADR-0030 contract artifact and unblock rollout
- Add ApiErrorSchema to @lazyit/shared matching the nestjs-zod/Nest error body, plus a reusable @ApiStandardErrors() decorator
- Standardize boolean query parsing behind one helper / z.stringbool (fix activeOnly vs lowStock divergence)
- Add an 'at least one field' .refine to the partial update schemas so empty-{} PATCH returns 400 instead of a no-op
- Add a documented public GET /healthz returning { status: 'ok' } (coordinate the guard exemption with the auth agent)

---

_Note: this document was materialized from the analyst's structured digest. The four analyses with full long-form write-ups on disk (backend-completeness-gaps, backend-observability-ops, backend-search-subsystem, infra-ops-reliability) include extra Method / Strategic-recommendations / Open-questions sections; the rest carry the digest above._
