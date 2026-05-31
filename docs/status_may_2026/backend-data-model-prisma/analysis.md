# Data model, Prisma schema, indexes, constraints, migrations

> Status snapshot — **2026-05-30** (`status_may_2026`). Team: **Backend**.
> Produced by a senior-analyst pass in the CTO multi-agent review fleet. Findings below are this analyst's structured digest (top findings, highest priority first).

**Headline:** Schema is clean and well-documented, but global unique constraints collide with soft delete, email is case-sensitive on the now-live OIDC path, and nothing is indexed for the deferred pagination contract.

## Findings (8)

### 1. Global unique constraints collide with soft delete — recreating a deleted email/name/slug/sku 409s forever

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| bug | high | medium | high |

- **Location:** `apps/api/prisma/schema.prisma:21,93,113,135,271,427 + every migration's CREATE UNIQUE INDEX; soft-delete.extension.ts:17-39 (reads only); prisma-exception.filter.ts:30-37`
- **Why it matters:** Every @unique is a FULL unique index with no WHERE deletedAt IS NULL predicate; the soft-delete extension only filters reads. Once a row is soft-deleted, its email/slug/name/sku stays reserved, so recreating it raises P2002 -> 409 'already exists' against an invisible ghost row, and there is no restore endpoint anywhere to revive it. Breaks natural workflows (rehire reuses email, re-add a retired laptop, reuse a deleted draft slug) and contradicts the 'loud actionable errors' mandate.
- **Recommendation:** After deciding reuse-vs-restore policy, drop @unique on soft-deletable fields and add raw-SQL partial unique indexes WHERE "deletedAt" IS NULL (same pattern already used for asset_assignments). Replace findUnique-by-that-field with findFirst.

### 2. email is case-sensitive — Bob@corp.com and bob@corp.com are two distinct users on the OIDC/JIT path

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| bug | high | small | high |

- **Location:** `apps/api/prisma/schema.prisma:21; migration 20260525052049_add_user_model (email TEXT + users_email_key)`
- **Why it matters:** User.email is plain TEXT with a case-sensitive unique index. With OIDC/JIT provisioning now live (ADR-0038/#59), case-variant logins create duplicate User rows or fail to match an existing user, corrupting the asset-assignment and access-grant audit trail since email is the human identity key in a single-org model.
- **Recommendation:** Use citext (CREATE EXTENSION citext; column @db.Citext) or app-level lowercase + functional unique index LOWER(email); combine with the partial-on-deletedAt index from finding #1.

### 3. No index supports the deferred pagination contract or the common filter/sort list queries

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| optimization | medium | medium | high |

- **Location:** `access-grants.service.ts:49-60 vs schema.prisma:396-397; users.service.ts:15-18; articles indexes schema.prisma:300-301 (lack deletedAt)`
- **Why it matters:** ADR-0030 commits to offset pagination and names GET /access-grants as first to migrate, but no list paginates and no index is shaped for it: there is NO index on deletedAt anywhere, none on the createdAt/name sort keys, and access_grants is filtered by revokedAt IS NULL + ordered by grantedAt with only single-column userId/applicationId indexes. Offset pagination over unindexed ORDER BY + filter is the slow path on the slow path as the platform grows.
- **Recommendation:** Add composite indexes matching access patterns, e.g. access_grants (applicationId, revokedAt, grantedAt) and (userId, revokedAt, grantedAt); partial (createdAt) WHERE deletedAt IS NULL on growing soft-deletable tables. Backend-only follow-up to ADR-0030.

### 4. Append-only history/ledger PKs are int4 SERIAL — 2.1B-row ceiling on the never-pruned audit tables

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| infra | medium | small | high |

- **Location:** `schema.prisma:212,456; migrations 20260526150000 / 20260526160000 (id SERIAL)`
- **Why it matters:** AssetHistory.id and ConsumableMovement.id are Prisma Int autoincrement -> Postgres SERIAL (int4 max ~2.1B). These are the two immutable, never-pruned, append-only tables (ADR-0006). For a tool meant to run for years on a customer's infra recording every asset event and stock movement, int4 exhaustion is a hard insert error on the audit log — auditability breaks exactly when needed. The fix is nearly free now, painful on a billion-row table later.
- **Recommendation:** Switch both PKs to BigInt / BIGSERIAL (@db.BigInt), keep them unexposed per ADR-0005. Small amendment to ADR-0005/0036.

### 5. CTO system-map doc drift confirmed — ArticleVersion is NOT in the schema

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| docs | low | quick-win | high |

- **Location:** `apps/api/prisma/schema.prisma (0 hits); docs/02-domain/entities/article-version.md:13-18`
- **Why it matters:** grep for ArticleVersion/article_versions in schema.prisma returns 0 hits; it exists only as a DEFERRED domain note (article-version.md:13-18) and in ADR-0021. The CTO system-map's claim that it exists is false and is treated as ground truth by other agents, causing wrong downstream assumptions.
- **Recommendation:** Correct the CTO system-map to mark ArticleVersion as deferred/not-built. Doc-only.

### 6. jsonb fields have zero DB-level guard; AssetHistory.payload has no zod gate at all

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| security | low | medium | medium |

- **Location:** `schema.prisma:116,141,218,294,350 (all Json?, no constraint)`
- **Why it matters:** Per ADR-0007 jsonb is validated by zod in the app, not the DB (intentional). But AssetHistory.payload is documented 'Unvalidated jsonb' and written by service code with no zod schema, and no column has a size cap or shape CHECK. A future endpoint forwarding client jsonb without the right schema, or a large history payload, could bloat rows — defense-in-depth gap that overlaps the SEC-002 untrusted-size mindset.
- **Recommendation:** Keep app-side validation (don't re-litigate ADR-0007) but consider cheap CHECK (pg_column_size < N) / jsonb_typeof='object' on user-facing jsonb and a typed zod schema per AssetHistory event type. Optional, needs ADR.

### 7. AccessGrant has no uniqueness — unlimited duplicate identical active grants on the most sensitive table

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| code-quality | low | small | high |

- **Location:** `schema.prisma:362-398 (model comment 'deliberately NO uniqueness'); contrast asset_assignments active partial index`
- **Why it matters:** AccessGrant intentionally allows multiple active grants per (user, app) at different accessLevels (ADR-0023, well-documented), but this also permits N identical active grants (same user/app/level, all revokedAt IS NULL) — noise on an access-audit table that makes 'who can access what' reports double-count and revocation ambiguous. AssetAssignment solved the analogous noise case with a partial unique index; AccessGrant did not.
- **Recommendation:** Consider a partial unique index on (userId, applicationId, accessLevel) WHERE revokedAt IS NULL — narrows, does not reverse, ADR-0023. Confirm with product owner.

### 8. Append-only / lifecycle-join immutability is enforced only by app convention, no DB guard

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| code-quality | low | medium | medium |

- **Location:** `schema.prisma AssetHistory/ConsumableMovement (createdAt only); AssetAssignment/AccessGrant marker columns; ADR-0006`
- **Why it matters:** asset_history and consumable_movements have no DB trigger/rule preventing UPDATE/DELETE, and nothing protects the immutable columns (assignedAt/grantedAt) of closed lifecycle rows. The soft-delete extension only touches reads. A stray prisma.assetHistory.update() or a careless future service would silently violate the ledger invariant — auditability is a first principle but currently a gentleman's agreement at the ORM layer.
- **Recommendation:** Optional hardening: Postgres RULE/trigger rejecting UPDATE/DELETE on the two append-only tables and on immutable lifecycle columns. Needs an ADR; lower priority than the unique-index fixes.

## Quick wins

- Correct the CTO system-map: ArticleVersion is NOT in the schema (confirmed 0 hits) — it is a deferred domain note only.
- Switch AssetHistory.id and ConsumableMovement.id from int4 SERIAL to BigInt/BIGSERIAL while the tables are still small — removes a long-term audit-log overflow failure mode.
- Lowercase/normalize email at the app write+lookup boundary as an interim guard for the case-sensitive-email duplicate hazard on the now-live OIDC/JIT path, ahead of a full citext migration.
- Document the soft-delete-vs-unique-constraint behavior (recreating a soft-deleted email/slug/sku 409s against an invisible row, with no restore endpoint) in code-conventions so it's a known limitation, not a surprise.

---

_Note: this document was materialized from the analyst's structured digest. The four analyses with full long-form write-ups on disk (backend-completeness-gaps, backend-observability-ops, backend-search-subsystem, infra-ops-reliability) include extra Method / Strategic-recommendations / Open-questions sections; the rest carry the digest above._
