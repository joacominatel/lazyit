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

## Sweeps so far

1. **2026-05-25 — initial backend baseline.** All committed modules at the time (users, locations,
   asset-categories, asset-models, assets, asset-assignments, article-categories, articles) +
   transversal (CORS, exception filter, shim, soft-delete, jsonb, infra). → SEC-001..SEC-007.
2. **2026-05-25 — Access pillar pass.** `applications`, `application-categories`, `access-grants`
   (+ nested `/users/:id/access-grants`, `/applications/:id/access-grants`), schema/migration and
   ADR-0023. → SEC-008; broadened SEC-004 (uuid path params) and SEC-007 (three more list endpoints).

Frontend (`apps/web`) and dependency auditing remain **out of scope**.

## Counts by severity (open)

| Severity | Count |
| --- | --- |
| Critical | 0 |
| High | 0 |
| Medium | 2 |
| Low | 6 |
| Info | 0 |
| **Total open** | **8** |

Deferred (accepted ADR debt, not findings): **5** — see [[deferred]].

## Open findings

| ID | Sev | Module | Title |
| --- | --- | --- | --- |
| [[SEC-001-import-unbounded-upload-dos\|SEC-001]] | 🟠 Medium | articles | Unbounded multipart upload buffered before the size check (DoS) |
| [[SEC-002-docx-decompression-bomb\|SEC-002]] | 🟠 Medium | articles | `.docx` decompression bomb (compressed size is checked, not expanded) |
| [[SEC-003-markdown-sanitizer-bypass-asymmetric\|SEC-003]] | 🟡 Low | articles | Bypassable, asymmetric markdown sanitizer (latent stored XSS) |
| [[SEC-004-unvalidated-uuid-query-params-500\|SEC-004]] | 🟡 Low | transversal | Malformed uuid inputs (query + `User.id` path params) → unhandled 500 |
| [[SEC-005-postgres-exposed-all-interfaces\|SEC-005]] | 🟡 Low | infra | Postgres on `0.0.0.0:5432` + trivial example creds |
| [[SEC-006-client-settable-external-id\|SEC-006]] | 🟡 Low | users | Client-settable `externalId` (future IdP pre-linking) |
| [[SEC-007-no-pagination-list-endpoints\|SEC-007]] | 🟡 Low | transversal | List endpoints have no pagination (unbounded responses) |
| [[SEC-008-application-url-href-xss-sink\|SEC-008]] | 🟡 Low | applications | `Application.url` stored unvalidated → `javascript:`/`data:` href XSS sink (latent) |

## Top findings

1. **SEC-001 / SEC-002 — import DoS (two mechanisms).** One unauthenticated request can OOM the API:
   the upload is buffered with no `multer` size limit (SEC-001), and even a limit-compliant `.docx`
   can decompress to gigabytes during mammoth parsing (SEC-002). Distinct fixes; both on
   `POST /articles/import`.
2. **SEC-003 / SEC-008 — latent stored XSS, two sinks.** Untrusted strings are stored unsanitized and
   become XSS the moment the (deferred) frontend renders them: KB markdown (SEC-003) and an
   application's `url` as a link href (SEC-008). Both **escalate to High** when the web app renders
   them — hand both to the Phase-3 frontend review as one "untrusted-string → web sink" policy.
3. **SEC-006 — `externalId` is client-settable.** The field the future OIDC integration keys on
   (`sub → externalId`) is accepted from `POST /users`, enabling account pre-linking once auth lands.
4. **SEC-005 — DB exposed on all interfaces with `postgres:postgres`.** Dev hardening, but a real
   exposure on shared networks and a default that must not reach production.
5. **SEC-004 / SEC-007 — input & resource hygiene.** Malformed uuid inputs throw 500s instead of
   400/404 (SEC-004, now incl. every `/users/:id` route); no list endpoint paginates (SEC-007, incl.
   the sensitive `GET /access-grants`). Low now, both grow with exposure/data.

## Posture context (not a finding — see [[deferred]])

lazyit is **unauthenticated by decision** ([[0016-auth-strategy-deferred]]) and **dev-only** ("must not
be exposed publicly"). The forgeable `X-User-Id` shim ([[0022-draft-visibility-auth-shim]]), public
Swagger ([[0018-api-documentation-swagger]]) and the Access pillar's open grant/revoke + "who-can-access-
what" reads ([[0023-access-management-design]]) all sit on that accepted baseline. **Aggregate risk:** if
this build is ever exposed publicly, the deferred items combine into a full read/write compromise — i.e.
effectively Critical on exposure, and the Access data is the prime recon target. The single most
important guardrail today is operational: **do not expose `:3001` (or `:5432`) beyond localhost/trusted dev**.

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
- **Out of scope:** frontend (`apps/web`, the render sink for SEC-003 / SEC-008), dependency CVEs,
  deploy infra (none exists). The `docs/README.md` root MOC does not yet list `06-security` (one line,
  outside the sentinel lane — left for an in-lane agent).

Related: [[deferred]] · [[06-security/_MOC|Security MOC]]
