# lazyit

A self-hosted, internal web app for small IT and Systems teams (5-20 people): asset inventory,
application access, consumables, and a knowledge base. ServiceNow-grade capability, modern and
opinionated. It runs in production on real instances that operators upgrade in place.

## Read these first

`docs/` is the source of truth — an Obsidian vault with `[[wiki-links]]` and a `_MOC.md` index
per folder. **When the documentation and the code disagree, the documentation wins**, and then
both are corrected in the same change. Start at `docs/README.md`.

`.claude/charter.md` holds the operational facts: branches, commit style, lanes, shared critical
files, the exact validation commands, and the three review dimensions every PR must clear.

| You need | Read |
| --- | --- |
| What and why the product is | `docs/00-overview/` |
| Stack, monorepo, deployment, the shared contract | `docs/01-architecture/` |
| Domain model and rules | `docs/02-domain/` and `docs/02-domain/entities/` |
| Why a decision was made | `docs/03-decisions/` — ADRs |
| Setup, conventions, how we work | `docs/04-development/` |
| Operations, deploy, backups | `docs/05-runbooks/` |
| Security findings | `docs/06-security/` |

## How we work

**1. Context before code.** Investigate the code for what was asked *and* search `docs/` for
the affected entity, the domain rules, and the relevant ADRs. No edits from a cold start.

**2. Ask, don't assume.** When a decision is needed and there is no reference to follow, ask.
Anything that could be critical — the data model, authorization, delete or migrate semantics,
security, irreversible actions — is escalated **before** acting. A wrong assumption costs more
than a question.

**3. Split front and back.** When work spans both, dispatch separate agents, one per side, each
with its lane from the charter. The contract between them lives in `packages/shared`.

**4. Documentation stays in sync.** Any change to behavior — especially core logic — reviews
and updates the affected notes in the same change. Before committing, verify nothing references
a removed file or a philosophy the change just altered. Stale documentation is a bug.

**5. The Manual too.** Any **user-facing** change — a feature, a changed behavior, a new
setting — also updates the in-app Manual at `apps/web/content/manual/` (`en` + `es`) in the
same change, per ADR-0062 and `docs/04-development/manual-authoring.md`. The Manual documents
lazyit for operators; a user-facing change is not done until its page is. This is separate from
the `docs/` vault above — a change that is both core and user-facing updates both.

**6. Check current library documentation.** Before using or upgrading an external library, read
its current official docs. Do not rely on memory; these versions move fast.

**7. Upgrade-safe over production data.** Operators update an existing, populated database.
Migrations are additive and nullable or defaulted; new validation enforces on write and stays
tolerant on read; the PR body says what happens to existing data. This is a mandatory review
dimension, not a nice-to-have — the full rule is in the charter and in
`docs/04-development/claude-workflow.md` §7.

## Delivery

Find the issue, branch from the base branch, work in a `.worktrees/` worktree, commit by
responsibility, open the PR. **Opening the PR is the default — do not ask first.** It is the
review surface, not the commitment: closing or amending one costs nothing, while waiting for
permission parks finished work.

Only the CEO merges into the protected branch. History is append-only: no `--amend`, `rebase`,
or `reset`, and never `add -A` or `add .`. No attribution trailers, generated-by notices, or
session links anywhere — commits, PR titles, PR bodies.

Branch names, prefixes, labels, and the validation commands are in the charter.
`docs/05-runbooks/git-workflow.md` is the step-by-step.

## Philosophy

- **Asset-centric.** The `Asset` is the first-class citizen, not the User — assets persist,
  people rotate. Ownership is a timestamped join (`AssetAssignment`), never a column, so history
  is automatic. → `docs/02-domain/asset-centric.md`
- **Auditability by default.** Never hard-delete domain data; soft delete instead. Logs and
  ledgers are append-only and immutable.
- **Opinionated over configurable.** A curated set of capabilities with sensible defaults.
- **Self-hosted, single-org, small-team operable.** Boring, durable technology.

## Bun is scoped

Bun is the runtime, package manager, and the default for scripts and tooling. It is **not** the
application server or data layer — those are deliberately NestJS and Prisma.
→ `docs/03-decisions/0009-bun-first-vs-app-stack.md`

Use Bun for tooling, scripts, and `packages/shared`: `bun`, `bunx`, `bun install`, `bun run` —
never npm, yarn, pnpm, npx, or node. Do not replace the app layer with it: the API stays on
NestJS, data access on Prisma, the frontend on Next.js, and API tests on Jest. The per-area
detail loads with the area's rules under `.claude/rules/`.

## Definition of done

Code in place · tests per `docs/03-decisions/0012-testing-strategy.md` · `docs/` updated and
consistent · the Manual updated for any user-facing change · the upgrade path over existing
production data verified · commits scoped and correctly prefixed · all three review dimensions
addressed in the PR body.
