# Feature ideation — Access pillar (applications, grants, requests)

> Status snapshot — **2026-05-30** (`status_may_2026`). Team: **Product / Features**.
> Produced by a senior-analyst pass in the CTO multi-agent review fleet. Findings below are this analyst's structured digest (top findings, highest priority first).

**Headline:** The Access pillar is a passive, wide-open ledger: no authorization, no leaver revocation, no expiry enforcement, no approval workflow — the highest-leverage backend work is to make granting/revoking trustworthy and to close the offboarding loop the docs already promise.

## Findings (10)

### 1. Deactivating or soft-deleting a user does NOT revoke their access grants (leaver gap)

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | high | medium | high |

- **Location:** `apps/api/src/users/users.service.ts:39-56; packages/shared/src/schemas/user.ts:39; docs/02-domain/entities/user.md:28-30,60-64`
- **Why it matters:** user.md:28-30 promises 'Offboarding a user must not erase history: assignments and grants are released, not deleted', and user.ts:39 says isActive 'toggles activation/offboarding' — but UsersService.update/remove never touch AccessGrant. A leaver keeps every active grant forever on the pillar whose stated purpose (access-grant.md:14) is offboarding. The revoke primitive already exists, making this the cheapest high-trust feature.
- **Recommendation:** Add a POST /users/:id/offboard (or an isActive true->false hook) that, in one $transaction mirroring asset-assignments.service.ts:115-129, revokes all the user's active grants (revokedById=actor, notes='auto: offboarded') and releases assignments, then deactivates. Never hard-delete; keep re-grantable.

### 2. No authorization model — every authenticated user can grant/revoke the most sensitive access

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| security | high | large | high |

- **Location:** `apps/api/src/auth/jwt-auth.guard.ts (no role check); ADR-0023:115-117; docs/02-domain/entities/access-grant.md:63-66; schema.prisma:19-53,347`
- **Why it matters:** Post-OIDC the global guard authenticates but applies zero authorization; there is no role/permission field on User (schema.prisma:19-53). Any logged-in person can POST /access-grants to self-grant admin on an isCritical prod app or revoke anyone. isCritical (schema.prisma:347) is stored but consulted nowhere. This blocks every higher-order Access feature (approval, reviews, SoD).
- **Recommendation:** PROPOSAL to extend ADR-0016 with a new ADR: smallest viable RBAC — a role enum (MEMBER|ADMIN) on User, JIT-mapped from an OIDC group/role claim, with @Roles('ADMIN') on the mutating Access endpoints. Resist enterprise RBAC (single-org/small-team per ADR-0015). Needs CTO sign-off (auth-contract change).

### 3. No AccessRequest -> approval workflow (access is admin-granted only) — the headline pillar gap

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | high | large | high |

- **Location:** `docs/02-domain/entities/access-request.md; docs/03-decisions/0023-access-management-design.md:119-123; no AccessRequest model in schema.prisma`
- **Why it matters:** The only way a grant exists is a direct POST /access-grants (controller:80-90) — no request, no approval, no record of who asked. ADR-0023:119-123 deferred this; access-request.md:21-34 already sketches requested->approved/rejected->provisioned producing an AccessGrant on approval. This turns the pillar from a passive ledger into the workflow the CEO's 'optimize all IT workflows' thesis needs.
- **Recommendation:** New cuid AccessRequest entity with a REQUESTED->APPROVED|REJECTED state machine that creates an AccessGrant in-transaction on approval (carrying requestedById for the audit chain). Keep it a distinct entity, not a ticket subtype. Depends on minimal RBAC. Defer approver-routing (Application vs team vs role) to the CTO.

### 4. expiresAt is informative only — nothing auto-revokes; no 'expiring soon' surfacing

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | medium | medium | high |

- **Location:** `apps/api/src/access-grants/access-grants.service.ts:39-61,139-147; access-grants/query-params.ts:14-21; schema.prisma:382-383; ADR-0023:124-127`
- **Why it matters:** An expired grant stays active (revokedAt=null); includeExpired=false only HIDES it from a list (query-params.ts:14-21) without changing the DB. No scheduler exists in the API (grep for @nestjs/schedule/BullMQ/cron = zero). Operators set expiresAt believing it protects them on the most sensitive pillar, and it does nothing.
- **Recommendation:** (a) Quick: add GET /access-grants?expiringBefore=<iso> (a where clause) so a dashboard/notification can surface lapsing grants. (b) PROPOSAL to extend ADR-0009/0023: add @nestjs/schedule (in-process cron, single-org) for a config-gated nightly auto-revoke of expired grants with a null system actor and notes='auto: expired'. Avoid BullMQ/Redis for one nightly sweep.

### 5. OIDC guard never checks isActive — deactivated users still authenticate and use their grants

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| security | medium | quick-win | high |

- **Location:** `apps/api/src/auth/jwt-auth.guard.ts:152-211; prisma soft-delete extension`
- **Why it matters:** The guard attaches any matching User to the request regardless of isActive (jwt-auth.guard.ts:152-211); the soft-delete extension filters deletedAt but not isActive. Deactivation — the documented offboarding lever (user.md:64) — neither cuts grants (Finding 1) nor login, a false sense of security on the crown-jewel surface.
- **Recommendation:** In both guard paths, treat isActive===false as unauthenticated: shim -> request.user=undefined, OIDC -> 401. Add a guard spec case. Independent of the broader RBAC ADR; ship first, alongside the leaver fix.

### 6. No separation-of-duties / critical-app gating — isCritical is inert

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | medium | medium | medium |

- **Location:** `schema.prisma:347; docs/02-domain/entities/application.md:33-34; apps/api/src/access-grants/access-grants.service.ts:78-99`
- **Why it matters:** isCritical is written through the API but no backend path treats a critical app differently (access-grants.service.ts:78-99 has no branch); application.md:33-34 admits it is 'informational for now'. Making it enforce something is the cheapest way to make the 'most sensitive data' claim real and matches what IT teams pay ServiceNow for.
- **Recommendation:** (a) Make isCritical force the approval workflow (a critical-app grant must come from an approved AccessRequest, never a direct POST). (b) Optional data-driven incompatible-app pairs returning 409 on conflicting grant-create. Keep rules few; do not build an enterprise policy engine. Depends on Findings 2+4.

### 7. No access-event audit log; metadata edits (expiry/notes) leave no trail

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | medium | medium | medium |

- **Location:** `apps/api/src/access-grants/access-grants.service.ts:126-147; compare apps/api/src/asset-history/asset-history.service.ts; access-grant.md:122-127`
- **Why it matters:** Assets have a first-class append-only AssetHistory feeding GET /assets/:id/history (asset-history.service.ts), but Access — which needs auditability more — has none. PATCH /expiry and /notes just update the row with NO actor (access-grants.service.ts:126-147), so extending a contractor's expiry is invisible afterward. Auditability-by-default is a first principle.
- **Recommendation:** Add an AccessEvent append-only log mirroring AssetHistory (autoincrement id, grantId, eventType GRANTED/REVOKED/EXPIRY_CHANGED/NOTES_CHANGED, payload jsonb, performedById), written in the same transaction as each mutation (consistent with ADR-0033). Minimum interim: thread @CurrentUser() into updateExpiry/updateNotes.

### 8. Access matrix / 'who can access what' view requires N+1 — grant rows are bare ids

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | medium | medium | high |

- **Location:** `apps/api/src/access-grants/access-grants.controller.ts:38-71; access-grants.service.ts:57-60; users.controller.ts:83-112; applications.controller.ts:58-87`
- **Why it matters:** Every grant-list endpoint returns raw AccessGrant rows with bare userId/applicationId and no include (service:57-60). Rendering the access matrix (the literal purpose statement, access-grant.md:14) forces the web app to N+1 fetch users and apps, pushing join logic to the frontend against the ADR-0020 data-layer discipline.
- **Recommendation:** Add an expanded read (expand=user,application) embedding {user:{id,name,email}, application:{id,name,isCritical}}, mirroring the existing relation-heavy backend-expanded-read pattern, plus a compact GET /access/matrix aggregate. Couple with pagination (SEC-007) so it is not an unbounded dump.

### 9. Integration / outbound provisioning webhooks on grant/revoke (deferred, anti-goal-sensitive)

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | low | large | low |

- **Location:** `N/A (no outbound webhook infra); pattern model at apps/api/src/applications/applications.service.ts:43-44`
- **Why it matters:** Granting in lazyit records but never provisions the real system. The aspiration ('provision via webhooks') could make the pillar operational, but risks the monitoring / phone-home / lock-in anti-goals. The fire-and-forget fail-soft Meili sync (applications.service.ts:44, ADR-0035) is a safe template for outbound side effects.
- **Recommendation:** Defer past everything above. When taken: opt-in, signed, fire-and-forget outbound webhook on grant created/revoked with a delivery log, its own ADR. Explicitly out-of-scope: any inbound polling of target systems (that is monitoring — anti-goal).

### 10. Revoke notes are free-text only — no machine-readable reason for future automation

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| code-quality | low | quick-win | medium |

- **Location:** `packages/shared/src/schemas/access-grant.ts:48-67`
- **Why it matters:** Revoke accepts only optional free-text notes (access-grant.ts:48-67). Once auto-revoke (Findings 1,3) lands, the audit trail cannot distinguish operator action from automation (expired vs offboarded vs review-revoked) without a structured reason.
- **Recommendation:** Add an optional revokeReason enum (MANUAL|EXPIRED|OFFBOARDED|REVIEW, default MANUAL) alongside the free-text note now, so later automation writes it from day one rather than a retrofit.

## Quick wins

- Guard isActive check: reject isActive=false users in jwt-auth.guard.ts (shim->anonymous, OIDC->401) + one spec case — closes the 'deactivation does nothing to login' surprise.
- Expiring-grants read filter: add expiringBefore=<iso> (or /access-grants/expiring) where-clause to AccessGrantsService.findAll — no new infra, surfaces lapsed contractor access.
- revokeReason enum stub on the revoke schema so future auto-revoke writes a machine-readable reason from the start.
- Capture @CurrentUser() actor on PATCH /expiry and /notes (access-grants.service.ts:126,139) so sensitive expiry extensions become attributable.

---

_Note: this document was materialized from the analyst's structured digest. The four analyses with full long-form write-ups on disk (backend-completeness-gaps, backend-observability-ops, backend-search-subsystem, infra-ops-reliability) include extra Method / Strategic-recommendations / Open-questions sections; the rest carry the digest above._
