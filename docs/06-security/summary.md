---
title: Security summary / dashboard
tags: [security, dashboard]
status: draft
created: 2026-05-25
updated: 2026-06-03
---

# Security summary

Snapshot of the security review. Updated each sweep. Method:
`.claude/skills/lazyit-sentinel/SKILL.md`. How to read: [[06-security/_MOC|Security MOC]].

## Sweeps so far

1. **2026-05-25 — initial backend baseline.** All committed modules at the time (users, locations,
   asset-categories, asset-models, assets, asset-assignments, article-categories, articles) +
   transversal (CORS, exception filter, shim, soft-delete, jsonb, infra). → SEC-001..SEC-007.
2. **2026-05-25 — Access pillar pass.** `applications`, `application-categories`, `access-grants`
   (+ nested `/users/:id/access-grants`, `/applications/:id/access-grants`), schema/migration and
   ADR-0023. → SEC-008; broadened SEC-004 (uuid path params) and SEC-007 (three more list endpoints).
3. **2026-05-26 — Post-sweep remediation.** SEC-001, SEC-004, SEC-005, SEC-006, SEC-008 were
   fixed by the remediator and moved to `docs/06-security/closed/`. Remaining open: SEC-002,
   SEC-003, SEC-007.
4. **2026-06-02 — Trust-boundary hardening (born-closed).** [[SEC-009-swagger-docs-public-anonymous-surface\|SEC-009]]
   (Swagger no longer public — `NODE_ENV` gate + Caddy) and
   [[SEC-010-setup-rate-limit-xff-spoof\|SEC-010]] (setup rate-limit + audit key on the verified
   `req.ip` via Caddy `trusted_proxies` + Express `trust proxy`) were filed **and** fixed in one PR;
   both went straight to `closed/`. DEF-003 (public Swagger) resolved by SEC-009.
5. **2026-06-03 — AuthZ epic (Roles & Permissions v2 + Service Accounts).** Not a sweep but a posture
   change: authorization moved to a **single DB-first `@RequirePermission` primitive** (the legacy
   `@Roles` retired), and the **read-authz gap closed** — `accessGrant:read` + `user:read` are
   pre-tightened to ADMIN + MEMBER, so a VIEWER can no longer enumerate the access map / user directory
   ([[0046-roles-permissions-v2]]). A second **service-account** principal (fail-closed, lazyit-native
   token, never ADMIN) landed with its own invariants ([[0048-service-accounts]]). The non-negotiables
   are [[INVARIANTS]] (INV-8 + INV-SA-1…4). This **resolves the DEF-001 residual** (the long-standing
   "reads open to any authenticated user").

Frontend (`apps/web`) and dependency auditing remain **out of scope**.

## Counts by severity (open)

| Severity | Count |
| --- | --- |
| Critical | 0 |
| High | 0 |
| Medium | 1 |
| Low | 2 |
| Info | 0 |
| **Total open** | **3** |

Deferred (accepted ADR debt, not findings): **3** active (DEF-001 ✅ — incl. its read-authz **residual**,
now closed by [[0046-roles-permissions-v2]] — and DEF-003 ✅ resolved) — see [[deferred]].

## Open findings

| ID | Sev | Module | Title |
| --- | --- | --- | --- |
| [[SEC-002-docx-decompression-bomb\|SEC-002]] | 🟠 Medium | articles | `.docx` decompression bomb (compressed size is checked, not expanded) |
| [[SEC-003-markdown-sanitizer-bypass-asymmetric\|SEC-003]] | 🟡 Low | articles | Bypassable, asymmetric markdown sanitizer (latent stored XSS) |
| [[SEC-007-no-pagination-list-endpoints\|SEC-007]] | 🟡 Low | transversal | List endpoints have no pagination (unbounded responses) |

## Top findings

1. **SEC-002 — `.docx` decompression bomb.** A limit-compliant `.docx` can decompress to gigabytes
   during mammoth parsing on `POST /articles/import`. The compressed size is checked; the expanded
   size is not. Fix: enforce an expanded-size cap before/during parsing.
2. **SEC-003 — latent stored XSS (markdown sink).** KB markdown is stored unsanitized and
   **escalates to High** the moment the frontend renders it. Hand to the Phase-3 frontend review as
   part of the "untrusted-string → web sink" policy.
3. **SEC-007 — unbounded list responses.** No list endpoint paginates (incl. the sensitive
   `GET /access-grants`). Low now, grows with exposure/data volume.

## Posture context (not a finding — see [[deferred]])

lazyit **authenticates** every request (global `JwtAuthGuard`, OIDC JWT or `X-User-Id` shim, plus a
**service-account** `lzit_sa_…` token branch — [[0038-jit-user-provisioning]], [[0048-service-accounts]])
and **authorizes** it with a single DB-first **`@RequirePermission`** primitive ([[0046-roles-permissions-v2]];
the legacy coarse `@Roles` gate is retired). Permissions resolve from DB rows (the [[role-permission]]
matrix for humans, direct grants for service accounts), never a token claim ([[INVARIANTS]] INV-8/INV-SA-1).
Writes stay ADMIN-only by seed (`accessGrant:grant`, `user:manage`, `:delete`); **the read map is now
tightened** — `accessGrant:read` + `user:read` are ADMIN + MEMBER only, so a VIEWER can no longer
enumerate the access map ([[0023-access-management-design]]) or the user directory. This **closes the May
review's #1 finding AND the read-authz residual** (the old DEF-001 baseline). Service accounts are
**fail-closed** (they 403 on unannotated routes — INV-SA-2) and never ADMIN-equivalent. **Residual
baseline:** the forgeable, dev-only `X-User-Id` shim ([[0022-draft-visibility-auth-shim]]) remains; the
OpenAPI docs are no longer public ([[SEC-009-swagger-docs-public-anonymous-surface\|SEC-009]]: prod
doesn't serve them, Caddy doesn't proxy `/api/docs*`; reachable only internally/in dev). **Aggregate
risk:** much reduced now that mutations are gated and the worst reads tightened, but the operational
guardrail still holds: **do not expose `:3001` (or `:5432`) beyond localhost/trusted dev**, and never run
production with `AUTH_MODE=shim`.

## Coverage & gaps (self-assessment)

- **Covered well:** all backend modules end-to-end (incl. the Access pillar), the `X-User-Id` shim authZ
  rules (vs ADR-0022/0023), the import pipeline, the exception filter, CORS, soft-delete consistency, the
  assignment/grant lifecycle (create live-checks, revoke 409), infra/env, and the cheap
  injection/exec/fs/logging invariants.
- **Access pillar — checked, matched its ADR:** create-time live-check of `userId`+`applicationId`
  (400), actor from a *validated* `X-User-Id` shim (better than AssetAssignment's body actor — see
  [[deferred]] DEF-005), double-revoke 409, no uniqueness (multi-grant by design), `strictObject`
  payloads. No divergence from ADR-0023.
- **Lighter / worth a second pass:** the `nestjs-zod` global pipe boundary (exactly which params are
  validated vs pass-through) was reasoned, not exercised; `mammoth` internals (XML entity handling)
  were not deep-audited (Phase-3 deps); no dynamic testing (API not run).
- **Out of scope:** frontend (`apps/web`, the render sink for SEC-003), dependency CVEs,
  deploy infra (covered by lazyit-devops; SEC-005 now closed).

Related: [[deferred]] · [[INVARIANTS]] · [[0046-roles-permissions-v2]] · [[0048-service-accounts]] ·
[[06-security/_MOC|Security MOC]]
