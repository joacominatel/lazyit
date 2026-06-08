---
title: lazyit Documentation
tags: [moc, root]
status: draft
created: 2026-05-25
updated: 2026-06-08
---

# lazyit — Documentation

> Internal IT operations platform for small teams (5–20 people): asset inventory,
> access management, tickets, consumables and a knowledge base. ServiceNow-grade
> capability, modern and opinionated, self-hosted.

This is the entry point and global **Map of Content (MOC)** for the project docs.
The vault is Obsidian-friendly: every folder has a `_MOC.md` index, notes use YAML
frontmatter, and internal references use `[[wiki-links]]`.

## How to read these docs

- New to the project? Start at [[vision]] → [[problem-space]] → [[asset-centric]].
- **About to build something? Read [[claude-workflow]] first** — it's the default operating
  procedure for every change (context-first, ask-don't-assume, subagents, commits, docs-sync).
- Setting up your machine? Go to [[setup]].
- Looking for *why* something is the way it is? See [[03-decisions/_MOC|Decisions (ADRs)]].
- **Automating provisioning?** The opt-in [[workflow-engine/_MOC|Applications Workflow Engine]] is
  shipped — substrate [[0053-async-workers-bullmq-valkey]], data model
  [[0054-applications-workflow-engine]].
- **Latest status snapshot:** [[status_jun_2026/README|Status — June 2026]] (the RBAC v2 + Service
  Accounts epic + the CEO's decisions). Prior: [[status_may_2026/README|May 2026]].

## Map of Content

| Section | Index | What lives here |
| --- | --- | --- |
| `00-overview` | [[00-overview/_MOC\|Overview]] | What lazyit is, the problem, the competition |
| `01-architecture` | [[01-architecture/_MOC\|Architecture]] | Stack, monorepo, `shared` contract, deployment |
| `02-domain` | [[02-domain/_MOC\|Domain]] | The asset-centric model, entities, conventions |
| `03-decisions` | [[03-decisions/_MOC\|Decisions]] | Architecture Decision Records (MADR-lite) |
| `04-development` | [[04-development/_MOC\|Development]] | How we work, setup, workflows, code conventions |
| `05-runbooks` | [[05-runbooks/_MOC\|Runbooks]] | Operations, deploy, troubleshooting |
| `06-security` | [[06-security/_MOC\|Security]] | Vulnerability findings, sentinel sweeps, deferred risks |
| `workflow-engine` | [[workflow-engine/_MOC\|Workflow Engine]] | Design vault for the shipped Applications Workflow Engine — substrate, data model, connectors, security, builder UX |
| `99-glossary` | [[99-glossary/_MOC\|Glossary]] | IT terms used across the docs |

## Doc conventions (this vault)

- **Language:** English everywhere — prose, identifiers, comments.
- **Frontmatter:** every note carries `title`, `tags`, `status`, `created`, `updated`.
  `status` is one of `draft | accepted | proposed | superseded`. ADRs use the ADR
  status vocabulary (see [[03-decisions/_MOC|Decisions]]).
- **Links:** prefer Obsidian `[[wiki-links]]`. Unique note names are linked bare
  (`[[asset]]`); folder indexes share the name `_MOC`, so link them by path with an
  alias: `[[02-domain/_MOC|Domain]]`.
- **Diagrams:** Mermaid fenced blocks (renders in Obsidian *and* GitHub). No binary
  `.canvas` files for now — see the gaps section.
- **Folder indexes:** each folder has a `_MOC.md` that lists and frames its notes.

## Project snapshot (as of 2026-05-25)

Verified against the repo, not just the briefing:

- Monorepo: Bun `1.3.14` workspaces + Turborepo `2.9`.
- `apps/web`: Next.js `16.2.6` + React `19.2.4`, runs on `:3000`.
- `apps/api`: NestJS `11.0.1`, runs on `:3001`.
- ORM: Prisma `7.8.0`; DB: PostgreSQL `18-alpine` via Docker Compose.
- Shared: `@lazyit/shared` (`packages/shared`) — currently only exports `APP_NAME`.

See [[stack]] for the full picture and [[02-domain/_MOC|Domain]] for what comes next.

---

## Gaps to fill (huecos por llenar)

Open items and assumptions. Resolve and then delete the entry.

### Decisions I assumed (reversible — tell me to change them)

- **Diagrams = Mermaid.** Chosen over Obsidian `.canvas` for portability and
  text-diffability. Flip to `.canvas` if you want freeform visual maps instead.
- **Doc versioning = `status` + `created`/`updated` in frontmatter.** Doc notes don't backlink
  to the commits/PRs that changed them. Repo-level traceability now lives in the GitHub
  issue/PR flow ([[git-workflow]]); add per-note commit/PR backlinks later only if needed.

### Resolved (briefing questions — decision log)

All open questions from the initial briefing are now decided (2026-05-25):

- **Soft delete on append-only tables** → *split by mutability*. Mutable domain entities get
  `createdAt` + `updatedAt` + `deletedAt`; append-only tables (history, ledgers) get
  `createdAt` only. See [[0006-soft-delete-and-auditing]] (accepted) and [[conventions]].
- **Asset ownership cardinality** → *concurrent many-to-many*. An asset may have multiple
  active owners at once (no uniqueness on the active owner). See [[asset-assignment]].
- **Bun-first vs app stack** → *scope `CLAUDE.md`*: Bun for runtime/tooling, NestJS + Prisma
  + Jest for the app layer. See [[0009-bun-first-vs-app-stack]] (accepted).
- **`DATABASE_URL` / env templates** → `DATABASE_URL` lives in `apps/api/.env`, read by the
  Prisma CLI via `prisma.config.ts` and by the API runtime via `nest start --env-file .env`.
  Prisma 7 also needs a driver adapter (`@prisma/adapter-pg`) and `moduleFormat = "cjs"`. One
  `.env` per scope (root + per-app), with committed examples. See [[setup]] · [[0003-prisma-orm]].

### Not written yet (intentional stubs)

- Entity **field tables** — added once a model lands in Prisma (most now have them); still conceptual-only
  for the not-yet-built entities (Ticket, AccessRequest — see [[entities/_MOC|Entities]]).
- **Async workers + the Workflow Engine are now built and shipped** (on `master`), no longer stubs.
  BullMQ on self-hosted Valkey with sandboxed processors ([[0053-async-workers-bullmq-valkey]])
  powers both the async `.docx` KB import (which closed SEC-002) and the opt-in
  [[workflow-engine/_MOC|Applications Workflow Engine]] ([[0054-applications-workflow-engine]])
  — "BullMQ executes, PostgreSQL remembers". Remaining pending ADRs: **CD / image publishing** and
  **E2E tooling** (see [[03-decisions/_MOC|Decisions]]).
  (The **auth IdP** is decided — Zitadel/BYOI, [[0037-idp-choice-zitadel-byoi]] /
  [[0043-zitadel-source-of-truth]]; **authorization** is decided — [[0046-roles-permissions-v2]] +
  [[0048-service-accounts]]; the **deployment model + topology** are built — [[0015-deployment-model]] /
  [[deployment]].)

### Honest scope — the shipped Workflow Engine (not yet battle-tested)

The [[workflow-engine/_MOC|Applications Workflow Engine]] is new — shipped, not yet hardened in
production. These are the *real* remaining gaps (deliberate v1 limits, not oversights):

- **No realtime yet — run/task status is polled.** The manual-task inbox and run timeline poll;
  there is no SSE stream or notification-bell push. The planned Settings & Notifications / SSE-bell
  ADR (the never-merged `0052`) was **dropped**, so realtime is a future item.
- **Connectors are public-HTTPS only.** v1 ships `REST` / `WEBHOOK_OUT` / `MANUAL` against public
  HTTPS targets. **On-prem / internal-target connectors** (the anti-SSRF egress guard denies
  private/loopback/IMDS) and **prebuilt SDK/MCP connectors** are future.
- **Triggers are event-only.** `ACCESS_GRANTED` / `ACCESS_REVOKED` fire workflows; **timer /
  scheduled / recertification triggers** are reserved enum slots with no behavior yet.
- **Workflow RBAC is coarse.** `workflow:read/manage/run/task/secrets` are global (ADMIN-default);
  there is **no per-application scope** on workflow permissions yet.
- **The manual-task inbox is a provisioning queue**, not a generic ticketing / approval system.
