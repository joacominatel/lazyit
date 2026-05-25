---
title: "ADR-0002: NestJS for the backend"
tags: [adr]
status: accepted
created: 2026-05-25
updated: 2026-05-25
deciders: [Joaquín Minatel]
---

# ADR-0002: NestJS for the backend

## Status

accepted

## Context

The API will grow to cover assets, tickets, access, consumables and a KB ([[02-domain/_MOC|Domain]]).
We want structure (modules, DI, testability) that scales with a multi-domain backend and a
strong TypeScript story, without hand-rolling architecture.

## Considered options

- **NestJS (Express)** — opinionated modules + dependency injection; first-class TypeScript;
  large ecosystem. Cons: heavier than minimal frameworks; runs on Express, not `Bun.serve`.
- **`Bun.serve` + a thin router** — minimal, fast, matches `CLAUDE.md`. Cons: we'd reinvent
  DI, validation, module boundaries; weaker for a large domain.
- **Fastify / Express directly** — flexible but unopinionated; structure becomes our problem.

## Decision

NestJS 11 (`@nestjs/platform-express`), strict TypeScript. DI suits the asset-centric domain
(e.g. an injectable `PrismaService`, services per bounded area).

## Consequences

- **Positive:** clear module boundaries, testable services, mature patterns for a growing API.
- **Trade-offs:** uses Express under the hood and Jest for tests, diverging from the
  `Bun.serve`/`bun test` guidance in `CLAUDE.md` — reconciled in [[0009-bun-first-vs-app-stack]].
- **Follow-ups:** define module structure as domain entities are implemented; add
  `PrismaService` ([[0003-prisma-orm]]).
