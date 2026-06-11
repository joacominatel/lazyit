---
title: Development Workflows
tags: [development]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# Development Workflows

Day-to-day commands. Root scripts delegate to Turborepo ([[monorepo]]).

## Running

| Task | Command | Notes |
| --- | --- | --- |
| Everything (web + api) | `bun run dev` | `turbo dev`; persistent, uncached |
| Database up / down | `bun run db:up` / `bun run db:down` | Docker Compose |
| Build all | `bun run build` | `turbo build`; outputs `dist/**`, `.next/**` |
| Lint all (report only) | `bun run lint` | `turbo lint`; **never mutates** the tree |
| Lint + autofix | `bun run lint:fix` | `turbo lint:fix`; rewrites fixable findings in place |
| Web only | `bun run dev` in `apps/web` | `next dev` on `:3000` |
| API only | `bun run dev` in `apps/api` | `nest start --watch` on `:3001` |

> [!note] `lint` is report-only and self-bootstraps Prisma
> The canonical `lint` task **never rewrites files** — run `bun run lint:fix` when you want
> the auto-fixes applied. The api lint is **type-aware**, so it needs the generated Prisma
> client; `turbo.json` wires `lint` to `dependsOn: ["db:generate"]` (`prisma generate`, cached
> on the schema), so a **clean checkout lints cleanly** without a manual generate step. The api
> eslint config ignores `generated/**` and `dist/**` (machine output is not hand-authored).

## Prisma (in `apps/api`)

| Task | Command |
| --- | --- |
| Create + apply a migration (dev) | `bunx prisma migrate dev --name <change>` |
| Apply migrations (prod) | `bunx prisma migrate deploy` |
| Seed initial data | `bunx prisma db seed` (asset categories; idempotent — config in `prisma.config.ts`) |
| Regenerate client | `bunx prisma generate` (→ `apps/api/generated/prisma`) |
| Regenerate client (via Turbo, cached) | `bunx turbo db:generate --filter=@lazyit/api` (lint depends on this) |
| Inspect data | `bunx prisma studio` |

Follow the domain implementation order when adding models — see [[02-domain/_MOC|Domain]].
After changing the schema, regenerate the client and (if contracts change) update zod
schemas in `@lazyit/shared` ([[monorepo]]).

## Testing

Policy in [[0012-testing-strategy]]: unit tests always; core/complex logic thoroughly.

- **API (`apps/api`):** Jest (`bun run test` → `jest`). Why Jest and not `bun test`:
  [[code-conventions]], [[0009-bun-first-vs-app-stack]].
- **Shared / scripts:** `bun test`.
- **Frontend / e2e:** deferred — no runner chosen yet.

## Git

Full step-by-step with commands: [[git-workflow]]. The short version:

- **Branches:** `master` = production (protected, user-only merges from `dev`), `dev` =
  integration, work on `<prefix>/issue-<n>-<slug>` branches **cut from `dev`**.
- **The loop:** find/open the issue (`gh issue list --search …`) → branch off `dev` → commit
  file-by-file → push → **hand off to the user and wait** → on their OK, `gh pr create --base
  dev`. **Agents never merge**; the user merges to `dev` and promotes `dev` → `master`.
- **Commits are file-scoped and minimal** (docs may be grouped), prefixed `feat` · `fix` ·
  `chore` · `del` · `updt` · `docs`. No `--amend`/`rebase`/`reset`, no `add -A`/`add .`.
- Before committing, **review `docs/` for sync** — no references to removed files or stale
  philosophy ([[claude-workflow]]).

Related: [[git-workflow]] · [[claude-workflow]] · [[setup]] · [[code-conventions]] · [[monorepo]] · [[0012-testing-strategy]]
