---
title: Security summary / dashboard
tags: [security, dashboard]
status: draft
created: 2026-05-25
updated: 2026-05-26
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

Deferred (accepted ADR debt, not findings): **5** — see [[deferred]].

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
- **Out of scope:** frontend (`apps/web`, the render sink for SEC-003), dependency CVEs,
  deploy infra (covered by lazyit-devops; SEC-005 now closed).

Related: [[deferred]] · [[06-security/_MOC|Security MOC]]
