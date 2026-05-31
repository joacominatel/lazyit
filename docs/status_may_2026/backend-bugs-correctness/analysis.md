# Backend bugs, edge cases, transaction & concurrency correctness

> Status snapshot — **2026-05-30** (`status_may_2026`). Team: **Backend**.
> Produced by a senior-analyst pass in the CTO multi-agent review fleet. Findings below are this analyst's structured digest (top findings, highest priority first).

**Headline:** The consumable stock cache has a real lost-update race that falsifies ADR-0034's atomicity promise; several smaller correctness/audit-fidelity bugs cluster around lifecycle joins, JIT identity, and unhandled int4 overflow.

## Findings (10)

### 1. Consumable currentStock cache: lost-update race under Read Committed (cache divergence + negative real stock)

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| bug | high | small | high |

- **Location:** `apps/api/src/consumables/consumables.service.ts:101-141 (claim: docs/03-decisions/0034-consumables-design.md:62-63)`
- **Why it matters:** createMovement does a JS read-modify-write (SELECT currentStock -> compute -> UPDATE) inside a transaction that runs at PostgreSQL default Read Committed (verified: no isolationLevel set anywhere). Two concurrent movements both read the same stock and the second commit silently overwrites the first — the cache diverges from the append-only ledger ADR-0034 declares the source of truth, and concurrent OUTs each pass the nextStock<0 check, driving real stock negative. ADR-0034:62-63 explicitly over-promises that cache and ledger 'can't diverge within a request'.
- **Recommendation:** Use atomic Prisma increment/decrement for IN/OUT and a guarded updateMany({where:{id,currentStock:{gte:q}}}) whose count===0 => 409, inside the same tx as the ledger insert; or run the tx at Serializable and retry on P2034. Amend ADR-0034's concurrency wording (PROPOSAL).

### 2. currentStock int4 overflow on repeated/large IN and ADJUSTMENT -> unhandled 500 (P2020)

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| bug | medium | quick-win | high |

- **Location:** `apps/api/src/consumables/consumables.service.ts:110-128; common/prisma-exception.filter.ts:29-59`
- **Why it matters:** quantity is int4({min:1}) up to INT4_MAX; IN computes currentStock+quantity and ADJUSTMENT sets currentStock=quantity. A large/accumulating IN writes >2,147,483,647 -> Postgres P2020. PrismaExceptionFilter only maps P2002/P2003/P2025/P2023, so P2020 falls through to a 500 and is logged as a CRITICAL server fault — violating the 'loud actionable errors' mandate for what is really a client/data condition.
- **Recommendation:** Reject nextStock>INT4_MAX with a 409/400 carrying an actionable message; optionally map P2020 -> 400 in PrismaExceptionFilter as a transversal net.

### 3. Soft-deleted Asset/User can still receive new assignments; FK Restrict does not catch it (asymmetry with Access pillar)

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| bug | medium | small | high |

- **Location:** `apps/api/src/asset-assignments/asset-assignments.service.ts:77-102 vs access-grants.service.ts:78-99,152-175`
- **Why it matters:** AccessGrant.create guards that userId/applicationId reference live (non-soft-deleted) rows -> 400. AssetAssignment.create has no such guard and inserts directly; soft delete is an UPDATE so the FK row still exists and the insert succeeds. You can open a brand-new active assignment for a departed (soft-deleted) user or a soft-deleted asset, corrupting the asset-centric ownership ledger and the audit story, with the row invisible in filtered reads.
- **Recommendation:** Mirror the Access pillar: assert both assetId and userId reference live rows (soft-delete-aware findFirst) before inserting -> 400. ~10 lines, aligns the two lifecycle joins.

### 4. JIT provisioning writes blank names and login-blocking 409 email collisions, bypassing the shared user zod contract

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| bug | medium | small | high |

- **Location:** `apps/api/src/auth/jwt-auth.guard.ts:152-211 (esp. 170-200)`
- **Why it matters:** On first login the guard builds a User from merged claims with no bounds: when only one of given_name/family_name is present the other becomes '' (the API's own create path requires min(1)); and email is @unique, so a token whose email matches an existing user throws P2002 -> 409 ON LOGIN with a generic message, blocking that sub entirely. This row is the actor on every audit record (assignments/grants/history), so its integrity is foundational.
- **Recommendation:** Validate/normalize the JIT profile via shared user primitives (non-empty name fallback, length caps) and handle email collision deliberately (link / clear 403 / distinct user) instead of a raw Prisma 409. PROPOSAL touching ADR-0038 — flag to CTO.

### 5. RELEASED asset-history event records no userId -> ambiguous timeline for multi-owner assets

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| bug | low | quick-win | high |

- **Location:** `apps/api/src/asset-assignments/asset-assignments.service.ts:94-99,124-128`
- **Why it matters:** ASSIGNED records payload {userId}, but RELEASED is recorded with no payload. The schema supports multi-owner assets, so a history of ASSIGNED A / ASSIGNED B / RELEASED cannot say whose assignment closed — undermining the auditable timeline that justifies the asset-centric design. The assignment object is already loaded at the call site.
- **Recommendation:** Add {userId: assignment.userId} (and optionally the assignment id) to the RELEASED event payload. One line.

### 6. accessGrant.create accepts client grantedAt/expiresAt with no ordering or future-bound validation

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| bug | low | quick-win | high |

- **Location:** `apps/api/src/access-grants/access-grants.service.ts:82-98; packages/shared/src/schemas/access-grant.ts:45-52`
- **Why it matters:** CreateAccessGrant validates grantedAt/expiresAt only as ISO datetimes; nothing prevents expiresAt<grantedAt (expires before it began) or far-future grantedAt. Same for assetAssignment.assignedAt. Garbage date states quietly pollute the most sensitive (Access) audit trail, making reports untrustworthy.
- **Recommendation:** Add a cross-field zod refine: expiresAt>=grantedAt when both present (and optionally bound future-dating). Pure shared-package change, no migration. PROPOSAL.

### 7. SPECS_CHANGED detection uses key-order-sensitive JSON.stringify -> false-positive audit events

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| bug | low | small | high |

- **Location:** `apps/api/src/assets/assets.service.ts:235-245`
- **Why it matters:** specs change is detected via JSON.stringify(before)!==JSON.stringify(updated), which is key-order sensitive; re-sending identical specs in a different key order — or jsonb storage canonicalizing key order on read — emits a spurious SPECS_CHANGED event, polluting the asset audit timeline (same audit-trust theme as the RELEASED-payload gap).
- **Recommendation:** Compare with a stable/sorted-key serialization or a small deep-equal before emitting SPECS_CHANGED.

### 8. Active-assignment pre-check runs outside the transaction; partial-index 409 is correct but its message is unfriendly

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| code-quality | low | small | high |

- **Location:** `apps/api/src/asset-assignments/asset-assignments.service.ts:77-102`
- **Why it matters:** The duplicate-active findFirst runs before/outside the insert transaction, so concurrent assigns both pass and one hits the partial unique index (P2002 -> generic 'A record with this <fields> already exists', where target metadata for a raw-SQL partial index is the index name or absent). The DB index keeps data safe (ADR-0019 intent) but the race loser gets a worse error than the serial path, and the pre-check is a wasted query.
- **Recommendation:** Fold the check into the transaction (or drop it) and translate the specific P2002 on this index to the friendly 'active assignment already exists' message. PROPOSAL, consistent with ADR-0019.

### 9. findUnique on soft-deletable models is an unenforced soft-delete-bypass invariant

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| code-quality | low | quick-win | high |

- **Location:** `apps/api/src/prisma/soft-delete.extension.ts:30-39 (convention across services)`
- **Why it matters:** The soft-delete extension intentionally excludes findUnique (its where can't take deletedAt). The codebase disciplines this by always using findFirst for soft-deletable lookups, but the invariant is unenforced: one future findUnique on User/Asset/Article silently returns soft-deleted rows, reintroducing exactly the bypass class ADR-0032 eliminated.
- **Recommendation:** Make the extension throw on findUnique for soft-deletable models (fail-loud in tests) or add a lint rule forbidding it. PROPOSAL.

### 10. cuid query filters unvalidated -> inconsistent contract (garbage uuid 400s, garbage cuid silently returns [])

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| code-quality | info | small | high |

- **Location:** `apps/api/src/assets/assets.controller.ts:78-100; asset-assignments.controller.ts:51-61; articles.controller.ts:69-95`
- **Why it matters:** uuid query filters go through parseUuidQuery (400 on malformed), but cuid filters (categoryId/locationId/assetId/applicationId) pass straight to Prisma where. Being text columns they don't cast-error; a garbage cuid just matches nothing and returns an empty list, vs the uuid path's 400 — an inconsistent edge contract for the same 'validate query filters at the edge' convention.
- **Recommendation:** Add a parseCuidQuery (or generic parseIdQuery(value,schema,name)) and apply to cuid filters for symmetry. Low priority.

## Quick wins

- #2 Reject computed nextStock > INT4_MAX in createMovement with a 409 (and/or map P2020 -> 400 in PrismaExceptionFilter) to stop overflow 500s
- #7 Add {userId: assignment.userId} to the RELEASED asset-history payload — one line, disambiguates multi-owner timelines
- #8 Cross-field zod refine expiresAt >= grantedAt on CreateAccessGrantSchema (pure shared change, no migration)
- #9 Cross-field zod refine rejecting from > to on ConsumableMovementQuerySchema so bad ranges 400 instead of silently returning []
- #12 Slug-collision: return a slug-specific 409 (or auto-suffix) in article create/import instead of the generic 'already exists'
- #5 Make the soft-delete extension throw on findUnique for soft-deletable models (fail-loud guard) or add a lint rule

---

_Note: this document was materialized from the analyst's structured digest. The four analyses with full long-form write-ups on disk (backend-completeness-gaps, backend-observability-ops, backend-search-subsystem, infra-ops-reliability) include extra Method / Strategic-recommendations / Open-questions sections; the rest carry the digest above._
