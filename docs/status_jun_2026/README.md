---
title: Status — June 2026 (RBAC v2 + Service Accounts)
tags: [moc, status, review, auth, authz]
status: living
created: 2026-06-03
updated: 2026-06-03
---

# Status — June 2026: the RBAC v2 + Service Accounts epic

A point-in-time snapshot of the **authorization epic** the CEO directed and the team shipped to `dev`
in early June 2026: **Roles & Permissions v2** (fixed roles + fully-configurable permissions) and
**Service Accounts** (a non-human API principal), plus the **guided first-deploy bootstrap** and two
security closures. Verified against `dev` on **2026-06-03**.

> This folder mirrors the [[status_may_2026/README|May 2026]] format: a README (this file) + an
> **executive summary** that narrates the epic and **prominently lists the CEO's decisions** with their
> rationale, so the forks the CEO took stay visible and manageable. The ADRs are authoritative; this
> snapshot points at them.

## Read this

- **[[00-EXECUTIVE-SUMMARY|The decisions + what shipped + what's deferred]]** (`00-EXECUTIVE-SUMMARY.md`)
  — start here. §A the CEO's decisions (the forks, surfaced first); §B what shipped (schema, endpoints,
  auth, shared, frontend, security, infra); §C the new invariants; §D deferred / follow-ups.

## The decisions at a glance (full rationale in the summary)

1. **Roles & Permissions v2 = 3 FIXED roles + CONFIGURABLE permissions** — not dynamic custom roles.
   [[0046-roles-permissions-v2]] (supersedes the ADR-0040 authZ *mechanism*, keeps its per-domain
   philosophy).
2. **Read-authz closed with a safe default** — every `<domain>:read` to all roles EXCEPT
   `accessGrant:read` + `user:read` (ADMIN+MEMBER only). VIEWER can no longer enumerate the access map /
   directory.
3. **Permissions are lazyit-LOCAL** — never synced to the IdP (BYOI-safe); authZ stays DB-first.
4. **The matrix is FULLY configurable** — coarse verbs + `:delete` ARE grantable to MEMBER/VIEWER with a
   ⚠ warning (an admin-initiated delegation, accepted; no server block). ADMIN is immutable/full.
5. **Permissions UX = role-first** — presets + plain-language capabilities + fine-tune, NOT a comparison
   grid.
6. **Service Accounts = a SEPARATE model + a lazyit-native hashed token** (`lzit_sa_…`) — not a Zitadel
   machine-user, not a `User` flag; direct grants from the same catalog; never ADMIN/Role; fail-closed.
   [[0048-service-accounts]].
7. **`start.sh` = a guided, idempotent, NON-destructive first-deploy bootstrap.**
   [[0047-guided-first-deploy-bootstrap]].

## Where the canonical docs live

| Topic | Authoritative doc |
| --- | --- |
| Roles & Permissions v2 decision | [[0046-roles-permissions-v2]] |
| Service Accounts decision | [[0048-service-accounts]] |
| Guided bootstrap decision | [[0047-guided-first-deploy-bootstrap]] |
| The authZ architecture (how) | [[authorization]] |
| The non-negotiables | [[INVARIANTS]] (INV-8, INV-SA-1…4) |
| Entities | [[role-permission]] · [[permission-audit-log]] · [[service-account]] · [[service-account-permission]] · [[service-account-audit-log]] |
| Operate it | [[managing-service-accounts]] |

Prior arc: [[status_may_2026/README|Status — May 2026]] (this epic closed its TIER-0 gating decision —
RBAC — and the long-standing read-authz residual).
