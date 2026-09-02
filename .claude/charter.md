# Charter

The operational facts an agent acts on. The global harness owns the verbs; this file owns the
nouns. It records what this repository **does**, not what its documentation claims — where the
two disagree, the documentation is the source and this file is corrected.

## Identity

- **Repository**: `joacominatel/lazyit` — public
- **Owned by the CEO**: yes
- **What it is**: self-hosted IT operations platform for teams of 5-20 — asset inventory,
  application access, consumables, knowledge base
- **Source of truth for domain and decisions**: `docs/` (Obsidian vault, `_MOC.md` per folder)

## Branches

- **Base branch** (work starts here, PRs land here): `dev`
- **Protected** (agents never push or merge here): `master`
- **Branch naming**: `<prefix>/issue-<n>-<slug>` — prefix matches the commit prefix, slug is
  short kebab-case English
- **Promotion**: only the CEO merges `dev` into `master`, then tags a release

> `master` carries **no GitHub branch protection rule** (`gh api .../protection` returns 404).
> Its protection today is this charter plus the `guard-git.sh` hook. Treat it as protected
> regardless.

### Merge authority

`master` is the CEO's alone, always.

Into `dev`, the CEO has given the coordinator a standing authorization for low-risk, reviewed
PRs on green CI — typically a batch of security remediations or isolated fixes. It does **not**
extend to anything touching authentication or authorization, the admin and last-admin guards,
privilege escalation, deletes or migrations, or anything that needs a new ADR or a product
call. Those go to the CEO with the PR link and the reason.

When in doubt, it is not low-risk.

## Commits

- **Prefixes**: `feat` `fix` `chore` `del` `updt` `docs`, with an optional scope —
  `updt(api):`, `fix(web):`, `chore(deps):`. Bare prefixes are equally valid.
- **Granularity**: one logical responsibility per commit. Related documentation may be grouped.
  Splitting by file count is not the rule.
- **Issue reference**: `(#N)` in the subject when the commit belongs to a tracked issue.
- **Forbidden**: `--amend`, `rebase`, `reset`, `add -A`, `add .`, and any attribution trailer,
  generated-by notice, or session link.

## Issues and labels

- **Tracker**: GitHub. Find the issue before starting; open one when the scope is clear; ask
  the CEO when it is not.
- **Agent-opened issues carry**: `auto-generated`
- **Dimensions**: `type:` (feat · fix · chore · docs · perf · a11y · i18n · design-system) ·
  `area:` (backend · frontend · infra · security · docs) · `priority:` (critical · high ·
  normal · low)
- **Signals**: `needs-decision` when escalated to the CEO · `blocked` when waiting on another
  issue or external input

## Lanes

| Lane | May write | Must not touch |
| --- | --- | --- |
| backend | `apps/api/**`, `packages/shared/**`, `docs/02-domain/**`, `docs/03-decisions/**` | `apps/web/**`, `apps/agent/**`, `infra/**`, `.github/**` |
| frontend | `apps/web/**`, `docs/03-decisions/**` | `apps/api/**`, `apps/agent/**`, `infra/**`, `.github/**` |
| agent | `apps/agent/**`, `packages/shared/**` | `apps/api/**`, `apps/web/**`, `infra/**` |
| infrastructure | `infra/**`, `.github/**`, `compose*.yaml`, `.dockerignore`, `docs/05-runbooks/**` | `apps/**`, `packages/**` |
| documentation | `docs/**`, `*.md`, `apps/web/content/manual/**` | all application code |
| security review | nothing — writes findings to `docs/06-security/**` only | all application code |

`packages/shared` is writable from backend and agent because it is the contract both consume.
A change there is a contract change: say so in the PR and check the other side.

`apps/web/content/manual/**` belongs to the documentation lane, and a frontend unit shipping a
user-facing change writes it too. That overlap is intentional — see the Manual rule below.

Cross-lane edits need explicit authorization in the dispatch prompt, and the commit message
records it.

## Shared critical files

A unit touching any of these forces serial execution. No exceptions for convenience.

- `packages/shared/src/index.ts` — the barrel
- `apps/api/src/app.module.ts` — the module registry
- `apps/web/app/(app)/layout.tsx` — the app shell
- `apps/web/components/sidebar-nav.tsx` — the navigation registry
- `apps/web/content/manual/_nav.ts` — the manual navigation registry
- `package.json` and `bun.lock` at the root
- `compose.yaml`
- `docs/03-decisions/_MOC.md` — ADR numbering collides here

**Group parallel work by file ownership, not by subject.** When two items in a batch — two
security findings, two fixes — would touch the same file or the same shared module, one agent
owns both. Domain similarity is not a reason to split them, and file overlap is always a reason
to merge them into one unit.

## Validation

Run from the worktree before opening a PR. These mirror `.github/workflows/ci.yml`; when they
drift, CI is right.

```sh
bun install --frozen-lockfile
bun run --filter @lazyit/shared build          # shared must build before anything consumes it
(cd apps/api && bunx prisma generate)          # the client is required by typecheck and tests

bunx tsc --noEmit -p packages/shared/tsconfig.build.json
bunx tsc --noEmit -p apps/api/tsconfig.json
bunx tsc --noEmit -p apps/web/tsconfig.json
bunx tsc --noEmit -p apps/agent/tsconfig.json  # compile does not typecheck it (ADR-0074 §7)

(cd apps/api && node node_modules/.bin/jest)   # Node, NOT bun — jest 30 does not run under Bun
(cd packages/shared && bun test)
(cd apps/web && bun test)
(cd apps/agent && bun test)

# Lint gate: changed files only, run from inside the app directory.
(cd apps/api && bunx eslint <changed files>)   # the prettier/prettier rule lives here and bites
(cd apps/web && bunx eslint <changed files>)   # apps/web has no prettier rule

# When the manual or the message catalogs change:
(cd apps/web && bun run check:manual-parity)
(cd apps/web && bun run check:message-parity)
```

Repo-wide `bun run lint` is **report-only** in CI and reformats outside your scope locally — do
not run it. The blocking gate is the changed-files lint above.

**Not run locally**: Docker builds, the full compose stack, `infra/test/caddy-routing.sh`,
Trivy scans, and the API boot smoke. CI covers them.

## Review dimensions

Every PR clears all three, and the PR body addresses each one by name.

1. **Correctness** — it does what it claims, with tests that fail without the change.
2. **Security** — no new authorization, injection, or exposure surface. Findings live in
   `docs/06-security/`.
3. **Upgrade-safety over production data** — lazyit runs on live self-hosted instances that
   update `dev`→`master`→tag→`prisma migrate deploy` against a **populated** database.
   Migrations are additive and nullable or defaulted; no destructive drop, no `NOT NULL`
   without a default, no rename that strands rows. New validation is **write-only** and the
   read path stays tolerant of legacy values, preferring self-heal on the next natural write.
   New enum values, notification types, and config degrade gracefully on an already-updated
   app. The PR body states what happens to existing data on update.
   → `docs/04-development/claude-workflow.md` §7, `docs/03-decisions/0084-*`

## Documentation

- **Internal vault**: `docs/` — updated in the same change as the code. Before committing,
  verify nothing references a removed file or a philosophy the change just altered.
- **Decision records**: `docs/03-decisions/` (MADR-lite, numbered, indexed in `_MOC.md`)
- **User-facing surface**: `apps/web/content/manual/` (`en` + `es`) — **any** user-facing
  change updates it in the same change, per ADR-0062 and
  `docs/04-development/manual-authoring.md`. A change that is both core and user-facing updates
  the vault and the manual.

## Exceptions to global defaults

- `master` has no GitHub protection rule; it is protected by convention and by the hook.
- Repo-wide lint is knowingly not clean — a legacy backlog reported but not gated. Only changed
  files block.
- API tests run under Node rather than Bun. This is deliberate (ADR-0096), not an oversight.
