# lazyit — Project Guide for Claude

lazyit is a **self-hosted, internal web app for small IT/Systems teams** (5–20 people):
asset inventory, application access, tickets, consumables and a knowledge base.
Positioning: ServiceNow-grade capability, but modern, opinionated and IT-native.

> **The full documentation lives in `docs/`** — an Obsidian vault (YAML frontmatter,
> `[[wiki-links]]`, one `_MOC.md` index per folder). This file is the short orientation;
> **`docs/` is the source of truth.** When this file and the docs disagree, the docs win —
> then update both. Start at `docs/README.md` (global map + an open-questions "Gaps" section).

## How we work — workflow (READ FIRST)

Default operating procedure for **every** change. Full version:
`docs/04-development/claude-workflow.md`.

1. **Context before code.** Before doing anything, investigate the codebase for what's asked
   **and** search `docs/` for related material (affected entities, domain rules, ADRs,
   conventions). Fully contextualize the change before touching code.
2. **Ask, don't assume.** If a decision is needed and there's no clear reference, **ask the
   user — for everything.** Anything that could be **critical** (data model, auth,
   delete/migrate semantics, security, irreversible actions) → consult the user before acting.
3. **Front/back via subagents.** When a task spans frontend and backend, delegate to
   **separate subagents** (one frontend, one backend). Claude Code **orchestrates** — it
   specifies tasks and contracts; it does not implement both sides itself.
4. **Minimalist commits.** **One file per commit** (documentation may be grouped). Message
   prefixes: `feat` · `fix` · `chore` · `del` · `updt` · `docs`.
5. **Docs stay in sync.** Any change to the codebase — especially **core logic** — requires
   reviewing `docs/`; if it lands, update the docs in the same change. **Before committing,
   verify the docs don't reference removed files or a changed philosophy.**
6. **External libraries → latest docs.** Check current official docs (e.g. Context7 / web)
   before using or upgrading a library — don't rely on memory.

## Where things are (docs map)

| You need… | Read |
| --- | --- |
| What/why the product is | `docs/00-overview/` — vision, problem-space, competitors |
| Stack, monorepo, deployment | `docs/01-architecture/` |
| Domain model & rules | `docs/02-domain/` + `docs/02-domain/entities/` (one note per entity) |
| Why a decision was made | `docs/03-decisions/` — ADRs (MADR-lite) |
| Set up & day-to-day work | `docs/04-development/` — setup, workflows, code-conventions, claude-workflow |
| What goes in `@lazyit/shared` | `docs/01-architecture/shared-package.md` |
| Operations / deploy / backups | `docs/05-runbooks/` (stub until there's something to operate) |
| Vocabulary | `docs/99-glossary/` |

## Philosophy

- **Asset-centric.** The `Asset` is the first-class citizen, not the User — assets persist,
  people rotate. Ownership is a timestamped join (`AssetAssignment`), never a column, so
  history is automatic. See `docs/02-domain/asset-centric.md`.
- **Auditability by default.** Never hard-delete domain data (soft delete); append-only
  logs/ledgers are immutable.
- **Opinionated over configurable.** A curated set of capabilities, sensible defaults.
- **Self-hosted, single-org, small-team operable.** Boring, durable technology.

## Tech stack (verified against the repo)

| Layer | Choice | Version |
| --- | --- | --- |
| Runtime / package manager | Bun | 1.3.14 |
| Monorepo orchestration | Turborepo | ^2.9 |
| Frontend | Next.js (App Router) + React + Tailwind v4 | 16.2.6 / 19.2.4 |
| Backend | NestJS (Express), strict TypeScript | 11.0.1 |
| ORM | Prisma | 7.8.0 |
| Database | PostgreSQL (Docker Compose for dev) | 18-alpine |
| Shared | `@lazyit/shared` — zod schemas/types front↔back | workspace |

Ports: Web → `:3000` · API → `:3001` · Postgres → `:5432`.
Details and rationale: `docs/01-architecture/stack.md` and the ADRs.

## Repo layout

```
apps/web           Next.js frontend (@lazyit/web)
apps/api           NestJS + Prisma backend (@lazyit/api)
packages/shared    @lazyit/shared — shared types & zod (leaf: depends on nothing)
docs/              documentation vault
docker-compose.yml Postgres for dev
```

`web` and `api` never import each other — they talk over HTTP. Shared contracts go in
`@lazyit/shared` (one definition, no per-app duplicates).

## Commands

```sh
bun install                 # install all workspaces
bun run dev                 # turbo dev — runs web + api together
bun run db:up / db:down     # Postgres via docker compose
bun run build / bun run lint
# Prisma — run inside apps/api:
bunx prisma migrate dev --name <change>
bunx prisma generate        # client → apps/api/generated/prisma
```

> **Env:** one `.env` per scope, each with a committed `.env.example` to copy. Root `.env`
> (Postgres, for compose) + `apps/api/.env` (`DATABASE_URL`, `PORT`). `apps/web` has none yet.
> `cp .env.example .env` and `cp apps/api/.env.example apps/api/.env`. See `docs/04-development/setup.md`.

## Conventions

- **English everywhere** — code, identifiers, comments, docs.
- **Naming:** models singular PascalCase; DB tables pluralized snake_case via `@@map`.
- **IDs:** `uuid()` for sensitive/exposed entities (mainly `User`), `cuid()` for most domain
  entities, `autoincrement()` for logs/history. → `docs/03-decisions/0005-id-strategy.md`
- **Timestamps & soft delete:** `createdAt` everywhere; `updatedAt` + `deletedAt` (soft
  delete) on **mutable domain** entities; **append-only** tables (history, ledgers) get
  `createdAt` only. → `docs/03-decisions/0006-soft-delete-and-auditing.md`
- **Flexible asset specs:** type-specific attributes go in a `specs Json` (jsonb) field on
  `Asset`, validated by zod in `@lazyit/shared`. → `docs/03-decisions/0007-flexible-asset-specs-jsonb.md`
- **`@lazyit/shared`:** only what both `web` and `api` must agree on — zod schemas, inferred
  types, constants, **pure** framework-agnostic utils. No app deps, no framework code, no
  Prisma types. → `docs/01-architecture/shared-package.md`
- **Testing:** unit tests always; core/complex logic thoroughly. Jest (api), `bun test`
  (shared); frontend unit tests and e2e deferred; no global coverage gate (rigor on core via
  review). → `docs/03-decisions/0012-testing-strategy.md`
- **Frontend:** Next.js (App Router) + Tailwind v4 (shadcn/ui planned).
  → `docs/03-decisions/0010-nextjs-frontend.md`, `docs/03-decisions/0011-tailwind-styling.md`
- **Domain build order:** User + Location → AssetModel + AssetCategory + Asset →
  AssetAssignment + AssetHistory → Ticket + TicketComment →
  Application + AccessGrant + AccessRequest → Consumable + ConsumableMovement →
  Article + ArticleCategory + ArticleVersion. → `docs/02-domain/_MOC.md`

## Bun usage — SCOPED (important)

Bun is the **runtime, package manager, and default for scripts/tooling** — *not* the app
server/data layer, which is deliberately NestJS + Prisma. Decision:
`docs/03-decisions/0009-bun-first-vs-app-stack.md`.

**Do** use Bun for tooling, scripts and the shared package:

- `bun <file>` · `bunx <pkg>` · `bun install` · `bun run <script>` — never npm/yarn/pnpm/npx/node.
- `Bun.file` over `node:fs`; `` Bun.$`...` `` over execa; `bun:sqlite` over better-sqlite3.
- `bun test` for `packages/shared` and standalone scripts.
- Rely on Bun's automatic `.env` loading (no `dotenv`) — **except** `prisma.config.ts`, which
  imports `dotenv/config` because the Prisma CLI runs outside Bun's auto-load.

**Do NOT** "Bun-ify" the app layer (these choices are intentional — don't replace them):

- API HTTP server: **NestJS (Express)** — not `Bun.serve()`.
- Database access: **Prisma** — not `Bun.sql` / `pg` / `postgres.js`.
- API tests: **Jest** (in `apps/api`) — `bun test` is for shared/scripts only.
- Frontend: **Next.js** — not Bun HTML-import serving.
- Future async workers may use **BullMQ + Redis** (which pulls in `ioredis`) despite the
  `Bun.redis` preference — to be settled in an ADR when chosen.
