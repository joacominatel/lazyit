---
title: Security summary / dashboard
tags: [security, dashboard]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# Security summary

Snapshot of the security review. Updated each sweep. Method:
`.claude/skills/lazyit-sentinel/SKILL.md`. How to read: [[06-security/_MOC|Security MOC]].

## Last sweep

- **Date:** 2026-05-25
- **Scope:** backend — `apps/api` (all modules), `packages/shared` (zod), Prisma schema + migrations,
  `docker-compose.yml`, `.env.example`s, the `X-User-Id` shim, CORS. Frontend and dependency audit
  **not** in scope yet.
- **Method:** per-module vertical pass (users, locations, asset-categories, asset-models, assets,
  asset-assignments, article-categories, articles) + transversal pass (CORS, exception filter, shim,
  soft-delete, jsonb, infra), against the SKILL.md class catalog.

## Counts by severity (open)

| Severity | Count |
| --- | --- |
| Critical | 0 |
| High | 0 |
| Medium | 2 |
| Low | 5 |
| Info | 0 |
| **Total open** | **7** |

Deferred (accepted ADR debt, not findings): **5** — see [[deferred]].

## Open findings

| ID | Sev | Module | Title |
| --- | --- | --- | --- |
| [[SEC-001-import-unbounded-upload-dos\|SEC-001]] | 🟠 Medium | articles | Unbounded multipart upload buffered before the size check (DoS) |
| [[SEC-002-docx-decompression-bomb\|SEC-002]] | 🟠 Medium | articles | `.docx` decompression bomb (compressed size is checked, not expanded) |
| [[SEC-003-markdown-sanitizer-bypass-asymmetric\|SEC-003]] | 🟡 Low | articles | Bypassable, asymmetric markdown sanitizer (latent stored XSS) |
| [[SEC-004-unvalidated-uuid-query-params-500\|SEC-004]] | 🟡 Low | transversal | Malformed UUID query params → unhandled 500 |
| [[SEC-005-postgres-exposed-all-interfaces\|SEC-005]] | 🟡 Low | infra | Postgres on `0.0.0.0:5432` + trivial example creds |
| [[SEC-006-client-settable-external-id\|SEC-006]] | 🟡 Low | users | Client-settable `externalId` (future IdP pre-linking) |
| [[SEC-007-no-pagination-list-endpoints\|SEC-007]] | 🟡 Low | transversal | List endpoints have no pagination (unbounded responses) |

## Top findings

1. **SEC-001 / SEC-002 — import DoS (two mechanisms).** One unauthenticated request can OOM the API:
   the upload is buffered with no `multer` size limit (SEC-001), and even a limit-compliant `.docx`
   can decompress to gigabytes during mammoth parsing (SEC-002). Distinct fixes; both on
   `POST /articles/import`.
2. **SEC-003 — latent stored XSS in the KB.** The only sanitizer is a bypassable regex applied *only*
   on import; create/update store markdown raw, and the real defense (render-time sanitization) is
   deferred to a frontend that doesn't exist yet. **Escalates to High** the moment the web KB renders
   article content. Hand to the Phase-3 frontend review.
3. **SEC-006 — `externalId` is client-settable.** The field the future OIDC integration keys on
   (`sub → externalId`) is accepted from `POST /users`, enabling account pre-linking once auth lands.
   Cheap to fix now; otherwise the auth work inherits it.
4. **SEC-005 — DB exposed on all interfaces with `postgres:postgres`.** Dev hardening, but a real
   exposure on shared networks and a default that must not reach production.
5. **SEC-004 / SEC-007 — input & resource hygiene.** Unvalidated uuid query params throw 500s instead
   of 400s (SEC-004); no list endpoint paginates (SEC-007). Low now, both grow with exposure/data.

## Posture context (not a finding — see [[deferred]])

lazyit is **unauthenticated by decision** ([[0016-auth-strategy-deferred]]) and **dev-only** ("must not
be exposed publicly"). The forgeable `X-User-Id` shim ([[0022-draft-visibility-auth-shim]]), public
Swagger ([[0018-api-documentation-swagger]]) and client-supplied actor fields all sit on that accepted
baseline. **Aggregate risk:** if this build is ever exposed publicly, the deferred items combine into a
full read/write compromise — i.e. effectively Critical on exposure. The single most important guardrail
today is operational: **do not expose `:3001` (or `:5432`) beyond localhost/trusted dev**.

## Coverage & gaps (self-assessment)

- **Covered well:** all eight API modules end-to-end, the shim authZ rules (vs ADR-0022), the import
  pipeline, the exception filter, CORS, soft-delete consistency, the assignment race, infra/env, the
  cheap injection/exec/fs/logging invariants.
- **Lighter / worth a second pass:** the `nestjs-zod` global pipe boundary (exactly which params are
  validated vs pass-through) was reasoned, not exercised; `mammoth` internals (XML entity handling)
  were not deep-audited (Phase-3 deps); no dynamic testing (API not run).
- **Out of scope this sweep:** frontend (`apps/web`), dependency CVEs, deploy infra (none exists).
- **Landed during the sweep — unreviewed (next-pass target):** the Access pillar modules
  `applications/`, `access-grants/`, `application-categories/` (+ nested `users`/`assets` wiring) were
  committed by a parallel agent after this sweep's baseline. They are **not** covered here and are the
  first thing to review next — expect the same classes (the `X-User-Id` shim or its absence on
  `AccessGrant` writes, IDOR on nested routes, soft-delete, mass assignment, pagination).

Related: [[deferred]] · [[06-security/_MOC|Security MOC]]
