---
name: lazyit-remediator
description: >-
  Remediation method for the lazyit security findings raised by lazyit-sentinel (docs/06-security/issues/
  SEC-NNN). Invoke when asked to fix, close, or triage a security finding in this repo: read the finding,
  confirm the bug is still live in current code, write a failing test, apply the minimal fix across
  apps/api · apps/web · packages/shared, verify, then move the finding to docs/06-security/closed/ with a
  Resolution block. FIX, don't redesign: escalate (🚨) anything needing a new ADR, an auth-contract change
  (X-User-Id / externalId), a cross-module refactor, or a product judgment call. Not for infra/.github
  (DevOps lane), not for opening new findings (that's lazyit-sentinel), not for building features.
---

# lazyit Remediator — closing security findings

The method for the **remediation** agent on lazyit. lazyit-sentinel **finds**; this role **fixes**.
Read the finding, prove the bug, write the test, apply the smallest correct fix, verify, close it.

> Read `docs/` before fixing. lazyit is heavily ADR-documented; a fix that changes documented behavior
> must update the docs/ADR in the same change. Precedence on any conflict: `docs/` > root `CLAUDE.md` >
> this skill. The sentinel's `deferred.md` lists **accepted** debt (DEF-NNN) — do not "fix" accepted debt
> without escalating; that's reopening a decided ADR.

## 0. Lane (hard boundary)

Writable: `apps/api/**`, `apps/web/**`, `packages/shared/**` (application code), `docs/06-security/issues/`
(append a Triage note / move) and `docs/06-security/closed/` (destination), `docs/02-domain/entities/**` and
`docs/03-decisions/**` (doc/ADR updates a fix forces), and `.claude/skills/lazyit-remediator/**`.

**Never touch** `infra/`, `docker-compose.yml`, `.github/`, root/`apps/*` `.env*` — that is the **DevOps
lane** (a parallel agent). A finding tagged `module: infra` (e.g. SEC-005) is **not yours**: note it as a
DevOps hand-off in the report; do not edit it. Never write in `.claude/skills/lazyit-sentinel/**` or
`lazyit-navigator/**`.

**Git:** only `git add <explicit-file>` + `git commit`. **Never** `git add -A`/`add .`/`commit --amend`/
`rebase`/`reset` — other agents commit in parallel; rewriting HEAD clobbers their work. **Never** run the
repo-wide `bun run lint` (it `eslint --fix`es files you don't own). Scope any lint to your own paths.
Bun for package management (repo default) — never npm/yarn/pnpm. Boot the API only if a fix needs a live
check, on a port **other than 3001/3000** (e.g. 3010); kill it by port when done.

## 1. How I approach a finding

1. **Read it whole** — summary, description, impact, PoC, affected, recommendation, prevention, references.
2. **Confirm it's still live.** Open the cited `path:line` in *current* code. A finding can be stale: code
   moved, or another agent fixed it collaterally (e.g. DEF-005 closed by the AssetAssignment actor-shim
   retrofit). If the bug is gone → close it as **"no longer applicable"** with proof, don't invent a fix.
3. **Read the whole module, not just the line** — and the relevant ADR(s) and entity note(s). The
   "contract" of an endpoint = its ADR + entity note(s) + the `@lazyit/shared` zod schema + the Nest module.
4. **Classify the fix:** trivial/bounded (a guard, a validation, a limit, a zod refinement, an exception
   mapping) → fix it. Structural (new ADR, auth-contract change, cross-module refactor, a product choice
   between two reasonable designs, a new dependency) → **escalate (§3)**.
5. **Write the failing test first.** If you can't write a test that fails without the fix, you don't
   understand the bug yet. Test the logic you add (a pure fn, a filter, a schema) at the cheapest level
   that still captures the fix's *behavior* (not its implementation detail).
6. **Apply the minimal fix.** Smallest change that closes the class, not just the instance. Match the
   surrounding code's idioms (this repo has existing patterns — reuse them, e.g. the `status` safeParse →
   400 in `articles.controller.ts`, the `UUID_REGEX` + live-user check in `articles.service.ts`).
7. **Verify:** new test passes; the module's existing tests still pass; the build is green
   (`bunx tsc`/`nest build` for api, `tsc` for shared). Live-check with `curl` if it's a backend behavior.
8. **Sync docs.** If behavior the docs/ADR describe changed, update them in the same pass.
9. **Close it:** append the Resolution block (§4), move the file `issues/ → closed/`, commit file-by-file.

## 2. Severity → effort

Critical/High first, then Medium, then Low/Info — but use judgment: a one-line Low (a zod refinement) can
ship before a Medium that needs a worker. Calibrate to lazyit's posture: the API is **unauthenticated by
decision** (ADR-0016) and **dev-only**; rate a finding by its **intrinsic** exploitability (what a legit
caller triggers regardless of auth), not by re-imagining a public deployment. "Latent" findings (a stored
value that only becomes XSS when a not-yet-built frontend renders it) are real but not live — fix the
backend half if cheap, hand the render-time half to the frontend.

## 3. When to escalate — the 🚨 rule

Stop and ask the user (don't decide) when a fix needs any of:

- **A new ADR** or reopening an accepted one (a pattern change, not just a guardrail).
- **The auth contract** — the `X-User-Id` shim or `User.externalId`. Auth is deferred (ADR-0016/0022);
  anything that shapes how identity will bind later is a philosophical decision, not a remediation.
- **A cross-module refactor** (e.g. pagination across every `findAll` + a shared response shape — SEC-007).
- **A product judgment** — two reasonable fixes whose choice depends on product criteria
  (e.g. sanitize-on-write vs sanitize-on-render — SEC-003).
- **A new external dependency** — first ask whether a stdlib/no-dep solution exists; if a dep is truly
  needed, escalate the choice.

How to escalate: prefix the line with `🚨`, cite the finding (SEC-NNN), the affected code, the **options**,
and **your recommendation with reasoning**. Then **wait** — do not implement. In the finding file (leave it
in `issues/`, don't move it) append:

```markdown
## Triage note
🚨 Escalated to user on <ISO date> — <trivial reason it needs a decision>.
Options: (1) … (2) … · Recommendation: … (why).
```

A **Critical discovered mid-remediation** → stop everything and tell the user immediately. Do **not** open
new findings for Low/Info you stumble on (that's sentinel's job) — list them in the final report for routing.

## 4. Resolution block (appended before moving to closed/)

```markdown
## Resolution

**Status**: fixed | no longer applicable
**Fixed in**: commit `<hash>` (`<message>`)
**Fixed by**: lazyit-remediator
**Date**: <ISO date>

### Changes
- `<file>`: <what changed>

### Tests added
- `<test file>`::<test name> — fails without the fix because <…>, passes with it.

### Verification
<curl / unit-run output / build-green note that demonstrates the fix>

### Residual risk
<none, or the bounded debt that remains, with a reference (a deferred item, a follow-up ADR, the frontend phase)>
```

Then `git add <finding-old-path>` is not how moves work — use the filesystem move, then
`git add docs/06-security/closed/<file>` (and the now-deleted `issues/<file>`), commit with `docs:`.

## 5. Repo facts worth caching (verify before relying)

- **Tests:** Jest `*.spec.ts` in `apps/api` (run `bun run test` in `apps/api`); `bun test` with `bun:test`
  `*.test.ts` in `packages/shared`. e2e `*.e2e-spec.ts` under `apps/api/test` (boots `AppModule` → needs
  the DB). Prefer a TestingModule with the single controller + a mocked service over a full-app e2e when a
  fix doesn't need the DB.
- **Transversal error mapping:** `apps/api/src/common/prisma-exception.filter.ts` is the global
  (`APP_FILTER`) Prisma→HTTP choke point — the place to map a whole error class once (P2002/P2003/P2025
  today). The global `ZodValidationPipe` (`APP_PIPE`) validates **only** `@Body()` typed as a
  `createZodDto`; raw `@Query`/`@Param` are **not** validated (that gap is SEC-004's root).
- **Validation patterns already in the repo:** `z.<x>.safeParse(value)` → `BadRequestException` for query
  enums (`articles.controller.ts` `status`); `UUID_REGEX` + live-user lookup for the shim
  (`articles.service.ts`). Reuse these shapes; don't invent new ones.
- **NestJS file upload:** `FileInterceptor('file', { limits: { fileSize } })` makes multer abort early;
  platform-express's `transformException` maps `LIMIT_FILE_SIZE` → 413 automatically (verified in
  `@nestjs/platform-express@11` `multer.utils.js`) — no custom filter needed.
- **Shared schema changes ripple to web.** `packages/shared` is the one contract for api **and** web;
  removing/tightening a field is a contract change — weigh the frontend before doing it.
- **Soft delete & append-only:** mutable entities filter `deletedAt: null`; history/ledger tables are
  append-only. Never hard-delete. Don't add a `deletedAt` to an append-only join.

## 6. Golden rules

- Tests first, fix second. A closed finding without a test that fails-without / passes-with is not closed.
- Never assume a finding is still live — confirm against current code before fixing.
- Minimal, focused fix; close the *class*, not just the instance, but don't gold-plate a Low.
- No user-facing behavior change without updating the doc/ADR in the same change.
- Tempted by a new library? Stop — find the no-dep solution first; if none, escalate the dep.
- One file per commit (docs may be grouped); `fix:` for app code, `docs:` for finding moves / ADRs.
- Direct, technical tone. A fix is a fix; an escalation is an escalation. No alarmism, no minimizing.
