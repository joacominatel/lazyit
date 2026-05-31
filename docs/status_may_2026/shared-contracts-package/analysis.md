# Shared package — zod schemas, types, contract completeness & strictness

> Status snapshot — **2026-05-30** (`status_may_2026`). Team: **Cross-cutting**.
> Produced by a senior-analyst pass in the CTO multi-agent review fleet. Findings below are this analyst's structured digest (top findings, highest priority first).

**Headline:** The shared zod layer is clean and well-tested, but the ADR-0030 pagination contract was never written, the build typecheck is looser than the editor's, and several response/search/user contracts drift from the code that emits them.

## Findings (10)

### 1. ADR-0030 pagination contract (PageQuery / Page<T>) was never written into shared

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| infra | medium | quick-win | high |

- **Location:** `packages/shared/src/** (absence); docs/03-decisions/0030-list-pagination-contract.md:38-40`
- **Why it matters:** ADR-0030 is accepted and states the contract is 'defined once in @lazyit/shared' so new endpoints follow one convention; a repo-wide grep finds no PageQuery/Page<T>/offset anywhere in shared, api, or web. The contract half of the ADR was skipped, so a new list endpoint (and the deferred SEC-007 retrofit starting with GET /access-grants) has nothing to import. The CEO's growth goal makes this the most likely future re-litigation point, and it is nearly free to add.
- **Recommendation:** Add packages/shared/src/schemas/pagination.ts: a coerced PageQuerySchema ({ limit: int4({min:1,max:200}).default(50), offset: int4({min:0}).default(0) }) and a generic pageOf<T>(item) factory returning { items, total, limit, offset } plus a Page<T> type alias; export from the barrel.

### 2. JIT user provisioning bypasses the shared User contract and can persist contract-invalid rows

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| bug | medium | small | high |

- **Location:** `apps/api/src/auth/jwt-auth.guard.ts:170-211 vs packages/shared/src/schemas/user.ts:14-37`
- **Why it matters:** UserSchema requires firstName/lastName min(1) and email z.email(), but the JIT path writes Prisma directly and can set lastName='' (guard.ts:194,198) and email=sub+'@unknown' (guard.ts:172, not a valid email). The API can thus return a User that fails its own published contract; web trusts the shape (compile-time only) and renders it. With OIDC/Zitadel live in prod, any IdP omitting family_name produces such a row on first login — exactly the drift the shared package exists to prevent.
- **Recommendation:** Decide with the auth owner: either relax UserSchema/User to allow empty lastName (and document it), or have the guard substitute a non-empty placeholder; make the no-email sentinel contract-valid (e.g. sub@no-email.invalid). Align schema + guard so the invariant holds.

### 3. Build typecheck does not enforce noUncheckedIndexedAccess — shipped .d.ts compiled under looser strictness

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| infra | medium | medium | high |

- **Location:** `packages/shared/tsconfig.json:22 vs packages/shared/tsconfig.build.json; .github/workflows/ci.yml:57-65`
- **Why it matters:** The editor base tsconfig.json sets noUncheckedIndexedAccess:true (line 22) but the emit config tsconfig.build.json — the one bun run build and CI's typecheck use — omits it; the CI comment (ci.yml:58-60) explicitly notes 'editor-only strictness not enforced by the build'. A contract package should be the strictest unit in the repo, not the loosest, and the shipped artifact uses the weaker rules. The gap widens as shared grows beyond pure declarations (e.g. a future pageOf/record-lookup helper ships without the | undefined the editor warned about).
- **Recommendation:** Have tsconfig.build.json extend the base (overriding only module/outDir/emit), or at minimum add noUncheckedIndexedAccess/noImplicitOverride/noFallthroughCasesInSwitch; verify current source still compiles and drop the CI caveat comment.

### 4. Cross-entity search response shape is defined twice and the two definitions disagree (partial vs total Record)

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| bug | medium | small | high |

- **Location:** `packages/shared/src/schemas/search.ts:86-101 vs apps/api/src/search/search.service.ts:19-35`
- **Why it matters:** Shared SearchResultsSchema is .partial() (every key optional, matching the runtime behavior of returning only requested indexes), but the API redefines SearchResults locally as Record<SearchIndex, SearchEntityResult> (all keys present) in search.service.ts:35 and the controller returns that, not the shared type. So the API's own type is wrong (claims keys that can be absent), the API does not consume the contract it ships, and api/web are typed against two different definitions of one endpoint — exactly what shared exists to prevent (ADR-0035). The API's hits is also typed unknown[] instead of the shared *Hit shapes.
- **Recommendation:** Make search.service.ts import SearchResults, SEARCH_ENTITIES, and the *Hit types from @lazyit/shared and align its internal type to the partial shape; remove the local redefinition.

### 5. Search query contract (q/entities/limit) lives only in the API, not in shared

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| code-quality | low | quick-win | high |

- **Location:** `apps/api/src/search/search.controller.ts:9-78; packages/shared/src/schemas/search.ts`
- **Why it matters:** Shared search.ts models only the response; the request validation (limit bounds 1-50/default 20, comma-split entity filter) is hand-rolled in the controller (parseEntities/parseLimit) with its own constants, and web's useSearch passes q/entities/limit with no shared constraint. The valid entity set is already a shared const (SEARCH_ENTITIES), so the matching query schema belongs beside it — today the web only discovers the limit cap by the server silently clamping.
- **Recommendation:** Add SearchQuerySchema and SEARCH_LIMIT_MAX/DEFAULT constants to search.ts; the controller keeps comma-splitting (query-string concern) but validates against the shared schema.

### 6. The z.record(z.string(), z.unknown()) jsonb pattern is copy-pasted in 5 schemas with no shared primitive

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| refactor | low | quick-win | high |

- **Location:** `application.ts:15, asset-model.ts:13, asset.ts:24, article.ts:19, asset-history.ts:25`
- **Why it matters:** Five schemas each declare a private XSchema = z.record(z.string(), z.unknown()) for their jsonb field (Application.metadata, AssetModel.specs, Asset.specs, Article.metadata, AssetHistory.payload), each with a near-identical TODO pointing at ADR-0007. ADR-0007 makes jsonb a deliberate transversal convention; a single primitive would make it discoverable and be the one place to attach future per-category specsSchema validation — the same 'define the primitive once' move ADR-0036 made for int4().
- **Recommendation:** Add jsonObject() (or JsonObjectSchema) to primitives.ts with the ADR-0007 doc comment and replace the five local copies.

### 7. Application.url is guarded on input but the entity/response schema is a bare z.string().nullable()

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| security | low | quick-win | high |

- **Location:** `packages/shared/src/schemas/application.ts:62 vs :47-55,77,90`
- **Why it matters:** isSafeApplicationUrl (the SEC-008 scheme guard) is applied to Create/Update url but ApplicationSchema.url (response/entity, line 62) is just z.string().nullable(). Inputs are guarded, but a future bulk-import path not using CreateApplicationSchema, or historical rows, would be typed/validated as safe when they may not be, and the OpenAPI response advertises no scheme constraint. Cheap defense-in-depth on the live stored-XSS lane (SEC-003/008) that keeps the contract self-documenting.
- **Recommendation:** Make ApplicationSchema.url use the same isSafeApplicationUrl refine, coordinated with the render-time sanitization owner (ADR-0029) so the layers are consistent, not redundant.

### 8. No email normalization in the shared contract — case/whitespace variants can create duplicate users

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| bug | low | quick-win | medium |

- **Location:** `packages/shared/src/schemas/user.ts:34,40; apps/api/src/users/users.service.ts`
- **Why it matters:** CreateUserSchema/UpdateUserSchema.email are z.email() with no .trim()/.toLowerCase() (neighboring string fields do trim), and users.service.ts has no normalization. Postgres text unique is case-sensitive by default, so Ada@B.com and ada@b.com can both persist as the same person; the JIT path compounds this by storing IdP email verbatim. Email is the human identity key and the IdP join in a small-team tool — duplicate rows break assignment/grant history and search.
- **Recommendation:** Add .trim().toLowerCase() to email in Create/Update schemas and apply the same in the JIT guard; confirm storage policy with the data owner before migrating existing rows.

### 9. Neither consumer validates responses against the shared schemas at runtime — lockstep is compile-time only

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| refactor | low | medium | high |

- **Location:** `apps/web/lib/api/client.ts:89; apps/web/lib/api/crud-endpoints.ts:22-33`
- **Why it matters:** Web apiFetch casts the body (return payload as T, client.ts:89) and createCrudEndpoints threads that cast through; no web endpoint .parse()s a response (only types are imported). NestJS does not re-validate outgoing DTOs either. So the only thing keeping front/back in lockstep is the shared TypeScript type, with zero runtime guard on outputs — exactly the class of drift in findings 1/2/5 goes undetected at runtime. Fine at MVP scale, but it is the literal answer to 'how to keep front/back in lockstep as the API grows': types + discipline, no safety net.
- **Recommendation:** Add API-side round-trip contract tests (serialized entity fixture -> *Schema.parse) so serializer drift fails in jest at the source; optionally dev-only .parse() in the web endpoint layer behind a flag.

### 10. Flat 20-line manual barrel with no namespacing or completeness check; watch the growth

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| code-quality | info | small | high |

- **Location:** `packages/shared/src/index.ts:1-23; packages/shared/package.json`
- **Why it matters:** index.ts hand-exports 17 schema files (~30+ schemas, ~50+ types) flattened into one namespace; collisions are avoided only by the Schema suffix + per-entity prefixes, a new schema file silently won't export if the barrel edit is forgotten, and packages/shared/package.json has no test script (only build) so completeness is unasserted. With Tickets/AccessRequest/ArticleVersion/dashboard-stats/bulk-import contracts coming, a 60-file flat barrel risks real collisions (Status/Query/Metadata).
- **Recommendation:** Add a 'test':'bun test' script to package.json now; when a new pillar's schemas land, consider sub-barrels (schemas/index.ts) or a check that every schemas/*.ts is re-exported. Defer the restructure until file count forces it.

## Quick wins

- Write the PageQuery / Page<T> schema into packages/shared/src/schemas/pagination.ts and export it — the accepted ADR-0030 contract that was decided but never written (pure addition, no rollout).
- Extract a jsonObject() primitive into primitives.ts and replace the 5 copies of z.record(z.string(), z.unknown()) across application/asset/asset-model/article/asset-history.
- Add SearchQuerySchema + SEARCH_LIMIT_MAX/DEFAULT constants beside the existing SEARCH_ENTITIES in search.ts so the request contract is shared, not hand-rolled in the controller.
- Normalize email with .trim().toLowerCase() in CreateUserSchema/UpdateUserSchema (confirm storage policy first).
- Apply isSafeApplicationUrl to ApplicationSchema.url so the response schema asserts the same SEC-008 invariant as the inputs.
- Add noUncheckedIndexedAccess (and friends) to tsconfig.build.json — or make it extend the base — so the shipped artifact is typechecked under strict rules; drop the CI caveat comment.
- Add a 'test':'bun test' script to packages/shared/package.json (CI runs bun test directly today, but the missing script is an inconsistency).

---

_Note: this document was materialized from the analyst's structured digest. The four analyses with full long-form write-ups on disk (backend-completeness-gaps, backend-observability-ops, backend-search-subsystem, infra-ops-reliability) include extra Method / Strategic-recommendations / Open-questions sections; the rest carry the digest above._
