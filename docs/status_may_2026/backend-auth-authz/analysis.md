# Authentication, authorization, and the missing access-control model

> Status snapshot — **2026-05-30** (`status_may_2026`). Team: **Backend**.
> Produced by a senior-analyst pass in the CTO multi-agent review fleet. Findings below are this analyst's structured digest (top findings, highest priority first).

**Headline:** Authentication (OIDC/JIT) is largely correct but has hardening gaps; the defining problem is the total absence of an authorization model — every authenticated user can read and mutate everything, including the sensitive Access pillar.

## Findings (10)

### 1. No authorization model: every authenticated user can do everything (incl. all Access grants)

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| security | high | large | high |

- **Location:** `apps/api/src/auth/auth.module.ts:14-18; apps/api/src/access-grants/access-grants.controller.ts (all verbs); apps/api/src/users/users.controller.ts:131`
- **Why it matters:** The global JwtAuthGuard only authenticates. A repo-wide grep finds no role/permission/scope anywhere and User has no role column (schema.prisma:19-53); the only ForbiddenException in the whole backend is KB author-only (articles.service.ts:286). So any logged-in user can grant/revoke any access grant, list the entire org access map, soft-delete any other user, and edit any asset. ADR-0023 itself flagged this as acceptable only pre-auth; auth has now landed (ADR-0038/0039), removing that precondition. For an IT tool whose whole purpose is auditable Access data, a junior contractor having the same power as the IT lead is the biggest backend completeness gap.
- **Recommendation:** PROPOSAL (new ADR): add a coarse, opinionated RBAC sized for 2-20 people — a single Role enum on User (ADMIN/MEMBER/VIEWER, default MEMBER), resolved by the guard onto request.user, enforced by a @Roles() decorator + RolesGuard after JwtAuthGuard. Bootstrap first JIT user as ADMIN (zero-config). Not per-resource ACLs or per-pillar scopes — that is over-engineering at this scale.

### 2. isActive=false and soft-deleted-then-recreated users bypass the auth boundary (broken offboarding)

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| security | high | small | high |

- **Location:** `apps/api/src/auth/jwt-auth.guard.ts:82,157-160,202-210; apps/api/src/users/users.service.ts:47-56`
- **Why it matters:** The guard never checks isActive — it is written true once at JIT (jwt-auth.guard.ts:208) and read nowhere else, so a lazyit-disabled account keeps full API access while its IdP token lives. Worse, offboarding is soft-delete only (users.service.ts:47-56); the soft-delete extension makes the externalId lookup (guard:157) return null, so the OIDC path treats the just-offboarded user as brand-new and JIT-re-provisions them with a fresh User.id on their next request — silently resurrecting the account and breaking the audit chain. Offboarding/audit is a core Access-pillar promise.
- **Recommendation:** Reject isActive=false with 401/403 in both guard modes. On the JIT path, look up externalId INCLUDING soft-deleted rows; if a soft-deleted match exists, return 403 (do not re-provision) so offboarding sticks and the old User.id audit links survive. Amend ADR-0038.

### 3. JIT provisioning is a check-then-act race (findFirst -> create, no transaction, no P2002 catch)

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| bug | medium | quick-win | high |

- **Location:** `apps/api/src/auth/jwt-auth.guard.ts:157-211`
- **Why it matters:** jitProvision does findFirst then create with no transaction and no unique-constraint handling, despite the comment at line 137 calling it an upsert. First login fires several parallel requests with the same fresh token for an unknown sub; two can both read null and both create, the second colliding on externalId @unique (schema.prisma:27) -> intermittent 500 on the very first login. That is the worst first impression for the IT-generalist operator and violates the loud-actionable-errors / zero-friction-first-login mandate.
- **Recommendation:** Make it a real upsert: prisma.user.upsert({ where:{externalId:sub}, create:{...}, update:{} }), or catch Prisma P2002 and re-findFirst on collision. ~30 min.

### 4. JIT email @unique collision permanently breaks login for two IdP subjects sharing an email

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| bug | medium | small | high |

- **Location:** `apps/api/src/auth/jwt-auth.guard.ts:170-210; apps/api/prisma/schema.prisma:21`
- **Why it matters:** JIT writes email into a column with @unique (schema.prisma:21). Two distinct IdP subs resolving to the same email (recreated user with new sub, shared service email, two federated sources) cause the second create to throw P2002 on email; existing-user lookup is by externalId so it never matches and that user can never log in, with an opaque DB error. Realistic SMB scenario; violates the loud-actionable-error mandate.
- **Recommendation:** Catch P2002-on-email distinctly and return a clear 409/422, OR relax email uniqueness and rely on externalId as the identity key (it already is). Decide via ADR — touches the User identity contract (ADR-0016).

### 5. No aud/audience validation unless OIDC_CLIENT_ID is set, and prod can ship without it

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| security | medium | small | high |

- **Location:** `apps/api/src/auth/jwt-auth.guard.ts:122-127; infra/env/.env.prod.example:79-81`
- **Why it matters:** jwtVerify passes audience ONLY when OIDC_CLIENT_ID is set (jwt-auth.guard.ts:122-127); otherwise audience validation is skipped entirely and there is no startup guard requiring it. The bundled Zitadel can host multiple OIDC clients, so a token minted for a different app on the same issuer would be accepted by lazyit — a confused-deputy/token-reuse risk on the sensitive Access data. RFC 9068 mandates aud validation for JWT access tokens.
- **Recommendation:** Require an audience check in OIDC mode: fail fast at startup if neither OIDC_CLIENT_ID nor an explicit OIDC_AUDIENCE is set, and always pass it to jwtVerify. Document the Zitadel audience config in auth-bootstrap.md.

### 6. AUTH_MODE=shim has no production safeguard — one stray env var fully disables auth

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| security | medium | quick-win | high |

- **Location:** `apps/api/src/auth/jwt-auth.guard.ts:59-85; apps/api/src/main.ts; apps/api/.env.example:30`
- **Why it matters:** The guard branches to shim on AUTH_MODE==='shim' (jwt-auth.guard.ts:59) and never 401s — absent/invalid X-User-Id just sets request.user=undefined and returns true. With no role checks (finding 1) this is a fully-open, impersonate-anyone API. There is no NODE_ENV/AUTH_MODE assertion in main.ts, and apps/api/.env.example ships AUTH_MODE=shim as the literal default. The IT-generalist operator who copy-pastes the dev example silently runs an unauthenticated prod holding access-grant data.
- **Recommendation:** In main.ts, refuse to start (loud throw) if AUTH_MODE==='shim' && NODE_ENV==='production'; and comment out AUTH_MODE=shim in .env.example so OIDC is the default and shim is opt-in.

### 7. No access-token refresh: users are silently logged out / hit 401 storms when the IdP token expires

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| frontend-ux | medium | medium | high |

- **Location:** `apps/web/auth.ts:104-122; apps/web/lib/api/client.ts:5-14`
- **Why it matters:** The Auth.js jwt callback stores access_token only on first sign-in with no refresh rotation (apps/web/auth.ts:104-122); on expiry the session copies an absent token as accessToken ?? '' so apiFetch sends an empty Bearer and the API 401s, while the session cookie may still satisfy the middleware. For an all-day tool, mid-session 401 storms with no recovery read as 'the app is broken'. ADR-0039 lists this as a known gap but it is left open-ended.
- **Recommendation:** Implement the standard Auth.js refresh-token rotation (store refresh_token + expires_at, refresh near expiry, force signOut on failure). Backend unaffected; schedule it rather than leaving it open.

### 8. Sensitive Access reads are unscoped and unpaginated (compounds the RBAC gap and SEC-007)

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| security | low | medium | high |

- **Location:** `apps/api/src/access-grants/access-grants.controller.ts:59-78`
- **Why it matters:** GET /access-grants returns ALL grants org-wide to any authenticated user with no pagination (access-grants.controller.ts:59-78), and no 'see only my own' notion exists. This is where the missing RBAC (finding 1) and deferred pagination (SEC-007) meet on the most sensitive data in the app — 'who can see who-can-access-what' is currently answered as 'everyone, all of it, in one unbounded response'.
- **Recommendation:** After RBAC lands, scope these reads so MEMBER/VIEWER see only their own grants and ADMIN sees all; implement the ADR-0030 Page<T> contract here first as the highest-value list to bound. Build on SEC-007, don't duplicate.

### 9. JIT identity fast-path trusts token claims when userinfo is unreachable (BYOI trust gap)

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| security | low | small | medium |

- **Location:** `apps/api/src/auth/jwt-auth.guard.ts:167-200`
- **Why it matters:** jitProvision merges userinfo OVER token claims but falls back to the token's own email/name when userinfo is null (jwt-auth.guard.ts:167-200). Safe for Zitadel-with-JWT, but ADR-0037's BYOI promise ('any OIDC IdP') includes IdPs whose access-token email/name are not authoritative identity — so a misleading email can be provisioned and shown next to access grants, contradicting ADR-0038's own 'token carries authorization, not identity' principle.
- **Recommendation:** Treat userinfo as authoritative and token claims as best-effort only; when userinfo is unreachable, provision with the neutral sub@unknown placeholder and a 'profile incomplete' state rather than an unverified token email. Lower priority; revisit when a non-Zitadel IdP is formally supported.

### 10. Doc drift: ArticleVersion claimed in schema (absent); superseded shim ADRs not cross-stamped

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| docs | low | quick-win | high |

- **Location:** `.claude/skills/lazyit-cto/references/system-map.md:55; decision-history.md:197; ADR-0022/0023/0024`
- **Why it matters:** CTO references claim ArticleVersion exists in schema (system-map.md:55; decision-history.md:197) but a grep of schema.prisma finds nothing — confirming the drift the CTO flagged. Separately ADR-0022/0023/0024 still describe the X-User-Id shim as the live actor model; ADR-0038 supersedes them in the OIDC path but they are not stamped as superseded, so a reader landing there first gets a stale auth picture. Docs are the source of truth (CLAUDE.md) and auth decisions ride on them.
- **Recommendation:** Correct the two reference lines to 'ArticleVersion deferred — not in schema' and add a 'superseded by ADR-0038 in the OIDC path' banner atop ADR-0022/0023/0024. (Editing these is outside a read-only mandate — hand to the CTO.)

## Quick wins

- JIT race fix: replace findFirst+create with prisma.user.upsert on externalId (or catch P2002 + re-read) — removes intermittent first-login 500s. ~30 min (jwt-auth.guard.ts:157-211).
- AUTH_MODE=shim prod guard: throw at startup in main.ts if AUTH_MODE==='shim' && NODE_ENV==='production', and comment out AUTH_MODE=shim in apps/api/.env.example so OIDC is the default. ~30 min.
- isActive enforcement: add `if (!user.isActive) throw UnauthorizedException('Account disabled')` after user resolution in both guard modes. ~20 min (jwt-auth.guard.ts:82 and :157-160).
- Pin the JWT algorithm: add algorithms:['RS256'] to the jwtVerify options. ~10 min (jwt-auth.guard.ts:120-127).
- Doc-drift fix: correct system-map.md:55 + decision-history.md:197 (ArticleVersion is deferred, not in schema) and add 'superseded by ADR-0038' banners to ADR-0022/0023/0024. ~20 min (hand to CTO — outside read-only mandate).

---

_Note: this document was materialized from the analyst's structured digest. The four analyses with full long-form write-ups on disk (backend-completeness-gaps, backend-observability-ops, backend-search-subsystem, infra-ops-reliability) include extra Method / Strategic-recommendations / Open-questions sections; the rest carry the digest above._
