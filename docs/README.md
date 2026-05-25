---
title: lazyit Documentation
tags: [moc, root]
status: draft
created: 2026-05-25
updated: 2026-05-25
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
- Setting up your machine? Go to [[setup]].
- Looking for *why* something is the way it is? See [[03-decisions/_MOC|Decisions (ADRs)]].

## Map of Content

| Section | Index | What lives here |
| --- | --- | --- |
| `00-overview` | [[00-overview/_MOC\|Overview]] | What lazyit is, the problem, the competition |
| `01-architecture` | [[01-architecture/_MOC\|Architecture]] | Stack, monorepo layout, deployment |
| `02-domain` | [[02-domain/_MOC\|Domain]] | The asset-centric model, entities, conventions |
| `03-decisions` | [[03-decisions/_MOC\|Decisions]] | Architecture Decision Records (MADR-lite) |
| `04-development` | [[04-development/_MOC\|Development]] | Local setup, workflows, code conventions |
| `05-runbooks` | [[05-runbooks/_MOC\|Runbooks]] | Operations, deploy, troubleshooting |
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
- Initial migration applied with a throwaway `HealthCheck` model. No domain model yet.

See [[stack]] for the full picture and [[02-domain/_MOC|Domain]] for what comes next.

---

## Gaps to fill (huecos por llenar)

Open items and assumptions. Resolve and then delete the entry.

### Decisions I assumed (reversible — tell me to change them)

- **Diagrams = Mermaid.** Chosen over Obsidian `.canvas` for portability and
  text-diffability. Flip to `.canvas` if you want freeform visual maps instead.
- **Doc versioning = `status` + `created`/`updated` in frontmatter.** No links to
  commits/PRs yet. Add commit/PR backlinks later if traceability becomes a need.

### Resolved (briefing questions — decision log)

All open questions from the initial briefing are now decided (2026-05-25):

- **Soft delete on append-only tables** → *split by mutability*. Mutable domain entities get
  `createdAt` + `updatedAt` + `deletedAt`; append-only tables (history, ledgers) get
  `createdAt` only. See [[0006-soft-delete-and-auditing]] (accepted) and [[conventions]].
- **Asset ownership cardinality** → *concurrent many-to-many*. An asset may have multiple
  active owners at once (no uniqueness on the active owner). See [[asset-assignment]].
- **Bun-first vs app stack** → *scope `CLAUDE.md`*: Bun for runtime/tooling, NestJS + Prisma
  + Jest for the app layer. See [[0009-bun-first-vs-app-stack]] (accepted).
- **`DATABASE_URL` / env templates** → datasource `url` comes from `DATABASE_URL` via
  `prisma.config.ts`; one `.env` per scope (root + per-app), with committed
  `apps/api/.env.example` and a completed root `.env.example`. See [[setup]].

### Not written yet (intentional stubs)

- `05-runbooks/*` — empty until there is something to operate (deploy, backups, on-call).
- Entity **field tables** — deliberately omitted; entities are conceptual-only until
  they exist in Prisma (see each note in [[entities/_MOC|Entities]]).
- ADRs for **auth** (NextAuth vs better-auth) and **async workers** (BullMQ + Redis) —
  placeholders noted in [[03-decisions/_MOC|Decisions]], to be written when decided.
- [[deployment]] — skeleton only; self-hosting target not yet chosen.
