---
title: "ADR-0009: Bun-first guidance vs the chosen app stack"
tags: [adr]
status: accepted
created: 2026-05-25
updated: 2026-05-25
deciders: [Joaquín Minatel]
---

# ADR-0009: Bun-first guidance vs the chosen app stack

## Status

accepted — enacted in the root `CLAUDE.md` on 2026-05-25.

## Context

The repo's `CLAUDE.md` states Bun-first rules: use `Bun.serve()` (not Express), `Bun.sql`
(not Prisma/pg), `Bun.redis` (not ioredis), and `bun test` (not Jest). But the deliberately
chosen app stack is **NestJS (Express) + Prisma + Jest** ([[0002-nestjs-backend]],
[[0003-prisma-orm]]), and the likely worker stack (BullMQ) depends on `ioredis`. Left
unreconciled, this confuses both contributors and AI assistants reading `CLAUDE.md`.

## Considered options

- **Follow `CLAUDE.md` literally** — drop NestJS/Prisma/Jest for `Bun.serve`/`Bun.sql`/`bun
  test`. Cons: throws away the structure, typing and migration story we chose those tools for.
- **Scope `CLAUDE.md`** — clarify that Bun-first applies to *runtime, package management,
  scripts and tooling*, while the app server/data layer is intentionally NestJS + Prisma. Keep
  `bun test` for `@lazyit/shared`/scripts, Jest for the Nest app.
- **Delete the Bun API guidance** — simplest, but loses useful defaults for scripts/tooling.

## Decision

Scope `CLAUDE.md`. Bun is the runtime, package manager and script/tooling default; the
application layer (HTTP server, DB access, app tests) is NestJS + Prisma + Jest by explicit
decision. The boundary is documented in [[code-conventions]] and was written into the root
`CLAUDE.md`, which now also serves as a short index into these docs.

## Consequences

- **Positive:** removes a standing contradiction; humans and assistants get consistent
  guidance; keeps the benefits of both Bun (tooling) and Nest/Prisma (app).
- **Trade-offs:** two test runners in the repo (Jest for api, `bun test` elsewhere); must be
  spelled out so contributors aren't surprised.
- **Follow-ups:** `CLAUDE.md` rewritten on 2026-05-25 to scope Bun usage and index the docs.
  Revisit the `Bun.redis` vs `ioredis` point when choosing the async worker stack (BullMQ).
