---
title: Security
tags: [moc, security]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# 06 — Security

Security review space for lazyit, maintained by the **`lazyit-sentinel`** blue-team agent
(method: `.claude/skills/lazyit-sentinel/SKILL.md`). Scope so far: the **backend** —
`apps/api` (NestJS + Prisma), `packages/shared` (zod), the Prisma schema/migrations,
`docker-compose.yml`, the `X-User-Id` auth shim, CORS and env config. Frontend and
dependency auditing are later phases.

> This space **finds and tracks** vulnerabilities; it does not fix them. Fixes are made by the
> feature agents in their own lanes. An item already accepted as conscious debt by an ADR is **not**
> a finding here — see [[deferred]].

## How this is organized

| Path | What it holds |
| --- | --- |
| [[INVARIANTS]] | The auth/authZ **non-negotiables** (ADR-0043 §6): the baseline a finding is measured against. |
| [[summary]] | Dashboard: counts by severity + the top findings. Updated each sweep. |
| `issues/` | One file per **open** finding, `SEC-NNN-slug.md`. |
| `closed/` | Findings that were fixed (and re-verified) or dismissed; moved here from `issues/`. |
| [[deferred]] | Risks that are **already accepted, documented debt** in an ADR — not new findings. |
| [[ISSUE_TEMPLATE]] | The report template. Copy it for each new finding. |

## Severity

| Level | Meaning |
| --- | --- |
| **Critical** | Remotely exploitable, no auth, serious impact (data exposure, RCE, takeover). User is alerted immediately. |
| **High** | Exploitable with basic access or a simple chain; medium-high impact. |
| **Medium** | Needs specific conditions or has partial mitigations. Default when severity is uncertain. |
| **Low** | Hardening / defense-in-depth / bad practice with no direct exploit. |
| **Info** | Observation or recommendation; no direct severity. |

**Calibration note.** lazyit is unauthenticated *by decision* ([[0016-auth-strategy-deferred]],
[[0022-draft-visibility-auth-shim]]) and dev-only ("must not be exposed publicly"). That accepted
posture is **not** re-filed as a Critical finding (it lives in [[deferred]]). Findings here are rated
by their **intrinsic** exploitability — a bug a legitimate caller can trigger regardless of auth — with
the dev-only context noted as mitigation where it applies. If the API is ever exposed publicly, every
deferred item escalates; that aggregate risk is framed in [[summary]].

## Status vocabulary (issue frontmatter)

`open` → triaged but unfixed · `triaged` → acknowledged, severity confirmed · `accepted` → risk
accepted (link the rationale) · `fixed` → fixed **and re-verified** (move to `closed/`) · `wontfix` →
dismissed with reason (move to `closed/`) · `duplicate` → of another SEC-NNN.

## How to read a finding

Each `SEC-NNN` is self-contained: summary → description → impact → PoC → affected (`path:line`) →
recommendation → prevention. PoCs marked *reasoned, not executed* were derived by code analysis; the
API is not run during review (engagement rule). Verify before acting on a fix.

## Glossary (security-specific)

- **Auth shim** — the `X-User-Id` header that stands in for real authentication until an IdP lands
  ([[0022-draft-visibility-auth-shim]]). Forgeable by design.
- **Soft-delete bypass** — a query that forgets `deletedAt IS NULL` and so reads/edits a logically
  deleted row ([[0006-soft-delete-and-auditing]]).
- **IDOR** — Insecure Direct Object Reference: reaching another principal's object by id with no
  ownership/visibility check.
- **TOCTOU** — time-of-check-to-time-of-use: a race between a pre-check and the write it guards.
- **Deferred** — a real risk that an ADR already accepts as conscious debt; tracked in [[deferred]],
  not as an open issue.

Related: [[INVARIANTS]] · `.claude/skills/lazyit-sentinel/SKILL.md` ·
[[03-decisions/_MOC|Decisions (ADRs)]] · [[claude-workflow]]
