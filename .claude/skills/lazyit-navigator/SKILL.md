---
name: lazyit-navigator
description: >-
  Use when working in the lazyit monorepo (apps/web Next.js, apps/api NestJS+Prisma,
  packages/shared). Orients on repo structure and where each thing lives (domain model,
  ADRs/decisions, conventions, runbooks, the shared contract), the reasoning path for any
  task (read docs/ before touching code, find the relevant ADR, ask the user when a
  decision is missing), how to split backend/frontend work into separate subagents, the
  file-by-file commit convention, and the docs/-update process. Invoke before implementing
  a feature, adding an endpoint/entity/model, wiring the frontend, or making any technical
  decision in this repo.
---

# lazyit Navigator

Orientation for working in the **lazyit** monorepo: *where things live* and *how to work*.

> **This file is an index and a way of working — not documentation.** The source of truth is
> always `docs/`. Where something is explained there, this file links to it instead of
> repeating it. Precedence on any conflict: **`docs/` > root `CLAUDE.md` > this skill.**
>
> Links below are Obsidian wiki-links into the `docs/` vault — resolve `[[name]]` to
> `docs/**/<name>.md` (the vault root is `docs/`).

## 1. Repo map — where things live

| Path | What it is |
| --- | --- |
| `apps/web/` | **Frontend** — Next.js 16 (App Router) + React 19 + Tailwind v4 (`@lazyit/web`, `:3000`) |
| `apps/api/` | **Backend** — NestJS 11 + Prisma 7 (`@lazyit/api`, `:3001`). Schema: `apps/api/prisma/schema.prisma`; config: `apps/api/prisma.config.ts`; generated client: `apps/api/generated/prisma` |
| `packages/shared/` | **`@lazyit/shared`** — zod schemas, inferred types, constants, pure utils shared by web↔api. Contract: [[shared-package]] |
| `docs/` | **The Obsidian vault — source of truth** (structure below) |
| `.claude/` | Claude config + this skill |
| root | Dev infra: `docker-compose.yml` (Postgres 18), root `.env`, `turbo.json`. *No `infra/` folder yet — may arrive with deployment ([[deployment]]).* |

### Inside `docs/`

| You need… | Go to |
| --- | --- |
| What/why the product is | [[00-overview/_MOC\|Overview]] — [[vision]], [[problem-space]], [[competitors]] |
| Stack & versions | [[stack]] |
| Monorepo layout / package boundaries | [[monorepo]] · shared contract → [[shared-package]] |
| **A technical decision & its rationale** | `docs/03-decisions/` — [[03-decisions/_MOC\|Decisions (ADRs)]] |
| **What an entity is / its rules** | `docs/02-domain/entities/<entity>.md` — [[entities/_MOC\|Entities]] |
| Domain/data conventions (IDs, soft delete, jsonb) | [[conventions]] |
| App code conventions / Bun boundary / testing | [[code-conventions]] |
| **How to develop (the workflow)** | [[claude-workflow]] |
| Setup & commands | [[setup]] · [[workflows]] |
| Operations / deploy | [[05-runbooks/_MOC\|Runbooks]] (stubs) |

> **The "contract" of an endpoint is not in one file** — it's the composition of: its
> **ADR** (if a decision applies) + the **entity note(s)** in `docs/02-domain/entities/` +
> the shared **zod schema** in `@lazyit/shared` + the **Nest module** in `apps/api/src/<area>`.

## 2. Reasoning path for any task

Follow this in order. Full rationale: [[claude-workflow]].

1. **Read the full request.** Don't start on a partial understanding.
2. **Identify the domain entities/modules it touches** — map them against [[02-domain/_MOC|Domain]].
3. **Read the relevant `docs/` before touching code** — the entity note(s), [[conventions]],
   [[code-conventions]], and anything the task obviously intersects.
4. **Find the ADR**, if one applies (`docs/03-decisions/`). Respect accepted decisions.
5. **If anything is unclear or a decision is missing → ask the user.** For *everything*.
   Anything that could be **critical** (data model, auth, delete/migrate semantics,
   security, irreversible actions) → consult before acting.
6. **If the task spans backend AND frontend → delegate to separate subagents** (one
   backend, one frontend). You orchestrate: define each subagent's task, the shared contract
   ([[shared-package]]), and acceptance criteria. Do not implement both sides yourself.
7. **Implement**, following the conventions in §3.
8. **Tests** per [[0012-testing-strategy]]: unit always; core/complex logic thoroughly.
9. **Update `docs/`** if core logic/behavior changed (entity notes, ADRs, conventions, diagrams).
10. **Commit file-by-file** with the right prefix (§3) — and **before committing, verify the
    docs are in sync** (no references to removed files or a changed philosophy).

> **Trivial changes** (typos, formatting, single-line copy): you may skip steps 4–6, but
> never skip step 9 (docs sync) if the change is user-facing.

## 3. Conventions to always respect

Summaries only — the linked doc is authoritative.

- **English everywhere** — code, identifiers, comments, docs.
- **Asset-centric** — the `Asset` is the first-class citizen; ownership is a timestamped join
  ([[asset-assignment]]), never a column. → [[asset-centric]]
- **Soft delete** — mutable domain entities get `createdAt`+`updatedAt`+`deletedAt` (never
  hard delete); **append-only** tables (history, ledgers) get `createdAt` only.
  → [[conventions]], [[0006-soft-delete-and-auditing]]
- **IDs by entity role** — `uuid()` for sensitive/exposed (e.g. `User`), `cuid()` for most
  domain entities, `autoincrement()` for logs/history. → [[0005-id-strategy]]
- **Flexible specs** — type-specific `Asset` attributes go in a `specs Json` (jsonb) field,
  validated by a zod schema in `@lazyit/shared`. → [[0007-flexible-asset-specs-jsonb]]
- **Naming** — models singular PascalCase; DB tables plural snake_case via `@@map`. → [[conventions]]
- **Testing** — unit always, core thorough; Jest (api), `bun test` (shared); FE & e2e
  deferred; no global coverage gate. → [[0012-testing-strategy]]
- **Bun is scoped** — runtime/package-manager/tooling default; the app layer is NestJS +
  Prisma + Jest (don't "Bun-ify" it). Concretely: don't swap NestJS/Express for `Bun.serve`,
  Prisma for `Bun.sql`, or Jest for `bun test` in the apps. → [[0009-bun-first-vs-app-stack]]
- **Commits** — file-by-file (docs may be grouped), prefixes `feat · fix · chore · del ·
  updt · docs`. → [[claude-workflow]]

## 4. What NOT to do

- ❌ **Don't make big decisions without asking the user.** When in doubt, ask.
- ❌ **Don't mix backend and frontend in the same agent** — use separate subagents.
- ❌ **Don't commit without checking coherence with `docs/`** (no stale/removed-file references).
- ❌ **Never `git commit --amend`, `rebase`, or `reset` when other agents may be committing in
  parallel.** They rewrite whatever `HEAD` is *now* — which a parallel agent may have just moved —
  so you can silently clobber *their* commit (and change its hash). Use **only normal commits with
  explicit per-file staging**: `git add <your-files>` then `git commit` — these stack on top of
  `HEAD` and never rewrite anyone's work. Never `git add -A` / `git add .` (you'd capture another
  agent's in-progress files).
- ❌ **Don't use an external library without checking its latest documentation** (Context7 / web).
- ❌ **Don't create new files without confirming where they belong** per the structure in §1.
- ❌ **Don't duplicate documentation content in code comments or other files** — link to
  `docs/` instead.
- ❌ **Don't hard-delete data**, don't renumber accepted ADRs, and don't duplicate a shared
  contract outside `@lazyit/shared`.

## 5. Cold-start example — "add a tickets endpoint"

Shows the path works from zero:

1. It touches **[[ticket]]** (and likely [[ticket-comment]], [[asset]], [[user]] — tickets are
   cross-cutting). Read those entity notes.
2. Check conventions: IDs (`cuid()`), soft delete, naming → [[conventions]]; backend module
   structure → [[code-conventions]].
3. ADRs that apply: [[0002-nestjs-backend]], [[0003-prisma-orm]], [[0005-id-strategy]],
   [[0006-soft-delete-and-auditing]].
4. Open question? `Ticket` isn't in Prisma yet (implementation order: Ticket is step 4 —
   [[02-domain/_MOC|Domain]]). If asked to build it before its prerequisites exist, or if the
   ticket workflow/states aren't defined → **ask the user**.
5. Scope: this is **backend-only** → no front/back split needed. Define the request/response
   **zod schema in `@lazyit/shared`**, then the Nest module under `apps/api/src/tickets`
   using a `PrismaService`.
6. **Jest tests** for the service/controller; cover the core logic thoroughly.
7. If this introduces/changes the `Ticket` model or rules → **update [[ticket]] and any ADR**.
8. **Commit file-by-file**: `feat: add ticket zod schema to shared`, `feat: add tickets module`,
   `docs: document Ticket fields`, etc.

---

Related entry points: [[claude-workflow]] · [[02-domain/_MOC|Domain]] ·
[[03-decisions/_MOC|Decisions]] · [[code-conventions]] · root `CLAUDE.md`.
