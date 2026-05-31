# Backend testing strategy, coverage gaps, test quality

> Status snapshot — **2026-05-30** (`status_may_2026`). Team: **Backend**.
> Produced by a senior-analyst pass in the CTO multi-agent review fleet. Findings below are this analyst's structured digest (top findings, highest priority first).

**Headline:** Unit specs are high-quality and behavior-focused (291 green in ~1.2s), but every integration seam — the global auth guard, zod pipe, exception filter, soft-delete Proxy, and all DB-only invariants (double-assign, FK restrict, stock races) — is mocked away and tested nowhere; the only e2e test is stale and silently excluded from CI.

## Findings (10)

### 1. The one e2e test is stale and silently excluded from CI — no working end-to-end coverage

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| testing | high | medium | high |

- **Location:** `apps/api/test/app.e2e-spec.ts:19-24; apps/api/test/jest-e2e.json; .github/workflows/ci.yml:82-84`
- **Why it matters:** Since ADR-0038 the global JwtAuthGuard 401s unauthenticated requests, so GET / -> 200 'Hello World!' would now fail; but CI runs plain `node node_modules/.bin/jest` (testRegex .spec.ts$), and the e2e config (.e2e-spec.ts$) has no CI step. The riskiest integration seams (guard, zod pipe, exception filter, soft-delete proxy, CORS/X-Request-Id) are exactly what unit tests mock away, and nothing exercises them together. Contradicts the 'loud actionable errors / one-command setup' product promise.
- **Recommendation:** Rewrite the e2e to assert the real contract (401 in OIDC mode, anonymous/200 in AUTH_MODE=shim), add a CI step running jest --config ./test/jest-e2e.json against a throwaway Postgres service container, and seed one user to drive the top flow end-to-end in shim mode.

### 2. No integration tests against Postgres — the explicitly-deferred DB invariants are tested nowhere

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| testing | high | large | high |

- **Location:** `apps/api/src/asset-assignments/asset-assignments.service.spec.ts:394-398; apps/api/src/access-grants/access-grants.service.spec.ts:369-373; apps/api/src/articles/articles.service.spec.ts:527-529`
- **Why it matters:** Multiple specs honestly document invariants they cannot cover because Prisma is mocked: the partial-unique index on active (asset,user) -> 409 (race-proof double-assign backstop), onDelete:Restrict FKs -> 400, slug-uniqueness -> 409, the soft-delete $extends proxy, and the lowStock FieldRef comparison. These are the product's core invariants (asset not double-owned, can't delete a referenced user, stock never lies) and the DB is the only real enforcer — yet nothing tests the DB. A wrong migration (dropped index / wrong onDelete) passes the entire green suite. ADR-0012 demands thorough invariant testing on core logic.
- **Recommendation:** Stand up a Prisma-integration tier (separate Jest project, *.int-spec.ts, disposable Postgres via Testcontainers or a CI service container) covering: concurrent double-assign -> 409, hard-delete of a referenced user -> 400, soft-delete proxy hides on findFirst/findMany but not findUnique, and lowStock correctness. This is the keystone investment.

### 3. Concurrency on the stock ledger and assignment open/release is untested (read-then-write races)

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| testing | high | medium | high |

- **Location:** `apps/api/src/consumables/consumables.service.ts (createMovement OUT/negative guard); apps/api/src/asset-assignments/asset-assignments.service.ts:77-102`
- **Why it matters:** consumables.createMovement reads currentStock then writes ±qty inside a transaction and rejects a negative OUT based on the READ value; the spec mocks $transaction to invoke the callback once, so two concurrent OUTs against stock 1 are never shown to be prevented. The same read-then-write shape exists in AssetAssignment.create (pre-check findFirst then create), relying on a unique index that (per the integration gap) is never exercised. Stock accuracy and single-active-ownership are core inventory invariants (ADR-0034/0006); a small IT team will run concurrent movements. The mocked unit test gives false safety confidence.
- **Recommendation:** In the integration tier, fire N parallel OUT movements and assert stock never goes below zero and successes == available stock. If a race is real, hand the fix (atomic guarded UPDATE ... WHERE currentStock >= :q, or stricter isolation) to the feature/remediator lane — but prove it with a test first.

### 4. 11 of 14 controllers have no spec — query-param coercion, defaults and guards untested at the edge

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| testing | medium | medium | high |

- **Location:** `apps/api/src/access-grants/access-grants.controller.ts and 10 other controllers without specs; vs users.controller.spec.ts / search.controller.spec.ts / articles.controller.spec.ts`
- **Why it matters:** Only users (SEC-004), articles (SEC-001) and search have specs — all written reactively to close security findings. Controllers carry real untested logic: query->filter coercion and the activeOnly/includeExpired/includeUser boolean defaults that services explicitly assume are 'set at the controller'. GET /access-grants is the most sensitive list endpoint (who-can-access-what); a default flip (showing revoked grants) would be an authZ/correctness bug the green suite misses. The 3 existing specs are a ready template.
- **Recommendation:** Add light supertest-against-createNestApplication controller specs (service mocked) for the higher-risk controllers first: access-grants, assets, asset-assignments, consumables. Assert filter coercion, default flags reaching the service, and uuid/ParseUuidQuery rejection. ~30 min each.

### 5. Controller/integration tests never run with the global guard, validation pipe or exception filter

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| testing | medium | medium | high |

- **Location:** `apps/api/src/app.module.ts:34-67; contrast users.controller.spec.ts:25-45 and search.controller.spec.ts:21-28`
- **Why it matters:** Every controller spec builds a bare TestingModule with no APP_GUARD/APP_PIPE/APP_FILTER, so: the global auth guard is never on the path (no test that unauthenticated requests are rejected or @CurrentUser populated); request-body zod validation (z.strictObject unknown-keys rejection, mass-assignment defense, int4 bounds) is never exercised through a controller; and the Prisma->HTTP mapping is unit-tested in isolation but never as the actual global filter shaping a response. SEC-006 (externalId not client-settable) is only 'covered by the schema test' — no test proves the global pipe rejects it through HTTP. The security posture is designed to live at these seams.
- **Recommendation:** In the e2e/integration tier, boot the real AppModule with AUTH_MODE=shim and assert end-to-end: 401 in OIDC mode unauthenticated; POST with an unknown body key -> 400 from the global zod pipe; duplicate active assignment -> 409 shaped by PrismaExceptionFilter; X-Request-Id echoed on errors.

### 6. JWKS verification path of the auth guard is mocked away — token signature/issuer/audience never exercised

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| testing | medium | small | high |

- **Location:** `apps/api/src/auth/jwt-auth.guard.spec.ts:7-10 vs apps/api/src/auth/jwt-auth.guard.ts:106-130`
- **Why it matters:** The guard spec is otherwise excellent (shim mode, JIT provisioning, name-claim fallbacks, userinfo enrichment fail-soft, Docker split-DNS X-Forwarded-* rewrite). But jose is mocked at module top, so the real verification is never tested: that a wrong-issuer/wrong-audience/expired/unsigned token is actually rejected, and that the OIDC_CLIENT_ID->audience option (subtle, security-relevant lines 124-126) is honored. The tests assert 'if jwtVerify rejects we 401' — never that a bad token makes it reject. This guard is the only authentication boundary for a tool holding sensitive Access data, and 'BYOI via 3 env vars' must work against real IdPs.
- **Recommendation:** Add a focused test that signs a real JWT with a local jose keypair, serves the JWKS via a stubbed fetch/local HTTP, and asserts: valid -> user; wrong issuer -> 401; expired -> 401; audience honored when OIDC_CLIENT_ID set, ignored when unset. One new spec; jose runs for real, only the network is stubbed.

### 7. Soft-delete $extends Proxy wiring is untested — only the pure helper is covered

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| testing | medium | small | high |

- **Location:** `apps/api/src/prisma/prisma.service.ts:31-56 vs apps/api/src/prisma/soft-delete.extension.spec.ts (helper only)`
- **Why it matters:** withSoftDeleteFilter (the pure fn) is thoroughly unit-tested, but the actual integration — the Prisma.defineExtension query override plus the non-trivial Proxy in PrismaService that routes prisma.user/$transaction/lifecycle calls (binds functions, falls back to Reflect.get) — has no test. A regression there would silently disable soft-delete filtering across the whole app (a data-leak/auditability failure, violating ADR-0006/0032) and the unit suite wouldn't notice. The filter is centralized so services don't repeat it, making this proxy the single point of failure.
- **Recommendation:** Cover it in the integration tier: create a row, soft-delete it, assert findMany/findFirst hide it, findUnique returns it, and {includeSoftDeleted:true} surfaces it through a real PrismaService against Postgres. Lighter unit alternative: instantiate PrismaService with a stub base client and assert the Proxy routes model access and $transaction through the extended client.

### 8. Spec quality is high and behavior-focused, but assertions are tightly coupled to Prisma call shape

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| testing | info | small | high |

- **Location:** `Representative: apps/api/src/consumables/consumables.service.spec.ts; articles.service.spec.ts; asset-assignments.service.spec.ts; access-grants.service.spec.ts`
- **Why it matters:** The service specs genuinely assert behavior/invariants (stock never negative, draft-privacy 404-vs-403, author-only writes, append-only release/revoke 409, search fail-soft swallowed-and-logged, actor from @CurrentUser not the body) — not the trivial mock-shape tests ADR-0012 warns against. The trade-off is many toHaveBeenCalledWith({where,data}) assertions: an innocuous query refactor (adding a select) breaks tests without a behavior change, nudging authors to edit the test to pass (churn-gaming). Worth naming for reviewers; the current specs are a strength, not a defect.
- **Recommendation:** Keep the behavior-first style. As the integration tier lands, move invariant assertions (negative stock, double-assign, soft-delete hiding) there and rely less on call-shape mirroring in unit tests — assert outcomes, not the query AST.

### 9. Coverage is not measured anywhere — test:cov exists but is never run, no per-module visibility

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| testing | low | quick-win | high |

- **Location:** `apps/api/package.json (test:cov, collectCoverageFrom: ['**/*.(t|j)s']); .github/workflows/ci.yml:82-84 (no --coverage)`
- **Why it matters:** ADR-0012 rightly rejects a global coverage gate (not proposing one), but the consequence is nobody can SEE which branches are uncovered (name-claim fallbacks, the includeExpired OR branch, error paths) without running test:cov locally, which no one does. collectCoverageFrom also includes main.ts/modules/DTOs/generated code, diluting the signal. 'Rigor on core enforced via review' needs visibility to review against — a non-gating report turns an opinion into evidence without metric-gaming.
- **Recommendation:** Add a non-blocking CI step running jest --coverage scoped to core service files (print/upload summary, no threshold) and tighten collectCoverageFrom to exclude main.ts, *.module.ts, *.dto.ts, generated/**. This is the 'core-scoped coverage gate later' ADR-0012 foresaw — start with a report, not a gate.

### 10. No negative-config test for PrismaService requiring DATABASE_URL (operator-experience guardrail)

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| testing | low | quick-win | high |

- **Location:** `apps/api/src/prisma/prisma.service.ts:24-29`
- **Why it matters:** PrismaService throws a clear error if DATABASE_URL is missing — exactly the loud, actionable error an IT generalist self-hoster needs — but no test pins that behavior/message. Misconfiguration is the #1 self-host failure mode; pinning the loud-error behavior protects the operator experience from a silent regression (e.g. someone adding a default).
- **Recommendation:** Add a 3-line unit test asserting `new PrismaService()` throws when DATABASE_URL is unset. Quick win.

## Quick wins

- Fix or delete the stale GET / e2e test (test/app.e2e-spec.ts) so it reflects the global-guard reality (401 unauthenticated / shim-mode 200) and add the missing 'Test API e2e' CI step
- Add a 3-line PrismaService unit test asserting it throws when DATABASE_URL is unset (pins the loud-error operator experience the product mandates)
- Add a non-blocking jest --coverage CI step scoped to core services and tighten collectCoverageFrom to exclude main.ts/*.module.ts/*.dto.ts/generated/** (visibility, not a gate per ADR-0012)
- Add a controller spec for GET /access-grants asserting the default activeOnly/includeExpired flags reach the service — the most security-relevant default in the app, reusing the existing search.controller.spec.ts pattern
- Add a real-jose guard test (sign a JWT locally, stub the JWKS fetch) covering valid / wrong-issuer / expired / audience-honored — the JWKS verification path is currently fully mocked

---

_Note: this document was materialized from the analyst's structured digest. The four analyses with full long-form write-ups on disk (backend-completeness-gaps, backend-observability-ops, backend-search-subsystem, infra-ops-reliability) include extra Method / Strategic-recommendations / Open-questions sections; the rest carry the digest above._
