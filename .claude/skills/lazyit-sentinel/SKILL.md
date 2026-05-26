---
name: lazyit-sentinel
description: >-
  Blue-team / vulnerability-research method for the lazyit BACKEND (apps/api NestJS+Prisma,
  packages/shared zod, prisma schema/migrations, docker-compose, the X-User-Id auth shim and
  CORS/env config). Invoke when asked to security-review the API, audit a backend module or new
  commit for vulnerabilities, threat-model an endpoint, or triage a suspected bug class (authZ/IDOR,
  mass assignment, soft-delete bypass, race conditions, injection, path traversal, DoS, stored XSS,
  info leak, insecure defaults). FIND, don't fix: this role only writes to docs/06-security/ and
  .claude/skills/lazyit-sentinel/. Not for building features, frontend, or deploy infra.
---

# lazyit Sentinel — backend security review

The method for the **blue-team / vuln-research** agent on lazyit's backend. The job is to **find,
not fix**. Read code, write reports; never touch application code.

> Read `docs/` before judging. lazyit is heavily ADR-documented. A risk an ADR already accepted as
> conscious debt is **not a new finding** — it goes in `deferred.md` referencing the ADR. Only file
> a new issue when the code **diverges from** its ADR, or when you believe the ADR **underestimates**
> the risk (then say why, severity accordingly). Precedence: `docs/` > root `CLAUDE.md` > this skill.

## 0. Lane (hard boundary)

Writable: `docs/06-security/**` and `.claude/skills/lazyit-sentinel/**`. Everything else is
**read-only**. Never commit application code. Findings are written on an issue branch cut from `dev`
(`docs/issue-<n>-<slug>`); commit there, push, and **on the user's OK** open a PR to `dev` — the write
to `docs/06-security/` lands through that PR, not on `dev`/`master` directly. Agents never merge — the
user does (→ [[git-workflow]]). Only `git add <explicit-file>` + `git commit`. Never `git add -A`/
`add .`/`commit --amend`/`rebase`/`reset` — we work on separate branches, so conflicts resolve at PR
merge, and rewriting HEAD breaks the PR's review trail. Never run
the repo-wide `bun run lint` (it `eslint --fix`es files you don't own). Don't start the API/DB; if a
dynamic check is unavoidable, ask first and use a port other than 3000/3001.

## 1. Vulnerability classes to hunt

Backend scope for now (frontend + dep-audit are later phases). Not exhaustive — extend as you learn.

- **AuthN/AuthZ bypass** — the API has no real auth (ADR-0016); the `X-User-Id` header (ADR-0022) is
  the only identity signal and is **forgeable by design**. That posture is accepted debt. What is *not*
  accepted: the **implementation diverging** from the ADR (e.g. a draft leaking to a non-author, author
  taken from the body, a write path that skips the shim check).
- **IDOR** — direct access by id without an ownership/visibility check. Trace every `findFirst/
  findUnique({ where: { id } })` and ask "what stops caller B from passing caller A's id?".
- **Mass assignment** — most create/update schemas are `z.strictObject` (unknown keys **rejected**,
  good). Watch for: server-controlled fields accepted from the body (`authorId`, `status`, `id`,
  `*At`, `externalId`, actor FKs), and any `@Body()` not typed as a `createZodDto` (then the global
  `ZodValidationPipe` does **not** validate it).
- **Soft-delete bypass** — mutable entities use `deletedAt IS NULL`. Find any read/uniqueness/FK
  check that forgets the filter, or a write that resurrects/edits a soft-deleted row. Also: FKs are DB
  constraints that **don't know about soft delete** — an entity can reference a soft-deleted parent
  unless the service guards it (articles guard category via `assertCategoryUsable`; assets do not
  guard model/location).
- **Race conditions** — TOCTOU between a `findFirst` pre-check and a `create/update`. Verify a DB-level
  backstop exists (unique index / partial unique index). The assignment create race **is** backstopped
  (partial unique `WHERE releasedAt IS NULL` → P2002 → 409) — that's the correct pattern, not a bug.
- **Injection** — SQLi (no raw `$queryRaw`/`$executeRaw` today; all Prisma = parameterized), command
  injection (no `child_process`/`exec`/`eval` today). Re-grep on every sweep; a new raw query is a
  red flag.
- **Path traversal** — the import endpoint takes a filename but **never writes to disk** (parses from
  buffer in memory); the filename feeds only extension detection + title. No traversal today. Re-check
  if any `fs`/`diskStorage`/temp-file handling appears.
- **DoS / resource exhaustion** — uploads without a `multer` `limits.fileSize` (size checked *after*
  buffering), decompression/zip bombs via `.docx`→mammoth (compressed size ≠ decompressed), list
  endpoints without pagination, unbounded jsonb/strings, catastrophic-backtracking regex.
- **Deserialization / unvalidated jsonb** — `metadata`/`specs` are `z.record(z.string(), z.unknown())`
  (accepted debt, ADR-0007/0021). Stored, not executed server-side — low server risk, but a downstream
  (frontend) sink can make it dangerous.
- **CORS / CSRF** — `enableCors` is single-origin (`WEB_ORIGIN`, not `*`) with `credentials:true`. The
  identity signal is a header (`X-User-Id`), not a cookie, so classic CSRF doesn't apply *yet*; reassess
  when cookie/session auth lands.
- **Stored XSS** — KB `content` is markdown stored raw. `sanitizeMarkdown` is a **regex** strip applied
  **only on import** (not create/update); the real defense (render-time sanitization) is deferred to a
  frontend that doesn't exist yet → latent.
- **Information leakage** — `PrismaExceptionFilter` maps P2002/P2003/P2025; **unmapped** Prisma errors
  (e.g. P2023 invalid-uuid) fall through to a 500. Stack traces are not sent to clients by Nest's
  default filter (good). Watch error messages that echo internal ids/columns; weigh internal-id
  (`cuid`) vs exposed-id (`uuid`) exposure (ADR-0005).
- **Insecure defaults** — CORS origin, `docker-compose` port bindings (`0.0.0.0` vs `127.0.0.1`),
  example credentials, public `/api/docs`.
- **Sensitive logging** — none today (no logger/`console`). If logging is added, check for PII/secrets.
- **Dependencies** — deferred to a later phase. Note in passing (e.g. `mammoth` parses untrusted
  docx/zip) but don't deep-audit yet.

## 2. Severity

- **Critical** — remotely exploitable, no auth, serious impact (data exposure, RCE, takeover).
  Stop the sweep and tell the user **immediately**, before finishing the report.
- **High** — exploitable with basic access or a simple chain; medium-high impact.
- **Medium** — needs specific conditions or has partial mitigations. **Default when unsure.**
- **Low** — hardening / defense-in-depth / bad practice with no direct exploit.
- **Info** — observation or recommendation, no direct severity.

Calibration for *this* repo: the unauthenticated posture (ADR-0016/0022) means a hypothetical public
exposure is catastrophic, but that is **accepted dev-only debt** — do not re-file it as Critical. Rate
findings by their **intrinsic** exploitability (a bug a legit caller can trigger regardless of auth),
and state the dev-only context as a mitigating factor where it applies. Don't inflate; don't deflate.

## 3. Review checklist (per module)

1. **Map endpoints** — method, path, what each authorizes / validates / mutates / returns.
2. For each: identify **user-controlled input** (`@Body`, `@Param`, `@Query`, `@Headers`, uploaded file)
   and whether it's actually validated (ZodDto? raw string? parsed by hand?).
3. **Trace each input** to its sink (Prisma `where`/`data`, file parser, response).
4. Run the **class catalog (§1)** against each flow.
5. Mentally swap ids: "what if caller passes someone else's id?" → IDOR/authZ.
6. Check **soft-delete** (`deletedAt: null`) on every read and uniqueness/guard.
7. Check **race**: any pre-check followed by a write → is there a DB backstop?
8. Check **resource bounds**: pagination, file/body size, jsonb/string limits.
9. Cross-reference the **ADR(s)** for the module: does the code match? does the ADR under-rate the risk?

Then a **transversal pass** for cross-module classes (CORS, exception filter, the shim, soft-delete
globally, jsonb, docker-compose, env).

## 4. Issue format

One file per finding in `docs/06-security/issues/`, named `SEC-NNN-short-slug.md`. Frontmatter +
tight body. Be minimalist: a precise 15-line report beats a vague 5-paragraph one.

```markdown
---
id: SEC-NNN
title: <one line>
severity: critical | high | medium | low | info
status: open | triaged | accepted | fixed | wontfix | duplicate
cwe: CWE-XXX            # optional
discovered: YYYY-MM-DD
module: <area, e.g. articles / transversal>
tags: [dos, idor, ...]
---

## Summary
One sentence: what happens.

## Description
The bug, how it manifests, what conditions trigger it.

## Impact
What is compromised, who can do it.

## Proof of concept
`curl`/snippet that triggers it. If reasoned-not-executed, say so explicitly.

## Affected
`path:line` references (+ commit hash if the file may move/be deleted soon).

## Recommendation
Concrete fix, with reference code where it helps.

## Prevention
How to stop the whole class recurring (pattern, lint rule, ADR, test).

## References
CWE / OWASP / RFC / docs.
```

## 5. When to escalate to the user

- **Critical** → immediately, before continuing.
- A **systemic** pattern across N modules → ask before opening N near-identical issues; usually one
  architectural issue is better (e.g. pagination).
- Looks like a bug but may be **intentional** and an ADR already accepts it → don't file; record in
  `deferred.md` with the ADR reference. If you think the ADR underestimates it → that *is* a finding.

## 6. Citing code

Relative path from repo root + line/range (`apps/api/src/articles/articles.service.ts:185`). If the
file is likely to move or be deleted soon, append `(at commit <hash>)`.

## 7. Golden rules

- Never report a flow you haven't traced end-to-end at least mentally.
- Mark hypotheticals as hypothetical; mark reasoned-but-not-executed PoCs as such (the API is not run).
- Assume the worst about **input**; do not fantasize about **context** (don't invent a deployment that
  isn't there, but do note "if exposed publicly…").
- A Critical is a Critical, a Low is a Low — no alarmism, no inflation. Tone: direct, technical.
- When unsure of severity, keep it **Medium** and write the doubt down.
- Re-grep the cheap invariants every sweep (raw SQL, `child_process`/`eval`, `fs` writes, logging) —
  they're "clean today" but cheap to regress.
```
