---
title: "ADR-0001: Monorepo with Bun workspaces + Turborepo"
tags: [adr]
status: accepted
created: 2026-05-25
updated: 2026-05-25
deciders: [Joaquín Minatel]
---

# ADR-0001: Monorepo with Bun workspaces + Turborepo

## Status

accepted

## Context

lazyit has a frontend, a backend, and shared contracts (types/zod schemas) used by both.
We want a single source of truth for those contracts, atomic cross-cutting changes, and one
place to run dev/build/lint. The team is small ([[vision]]), so operational simplicity
matters.

## Considered options

- **Polyrepo** — separate repos for web/api/shared; share contracts via a published package.
  Cons: versioning friction, cross-repo changes are not atomic, heavier for a small team.
- **Monorepo with npm/pnpm workspaces + Turborepo** — mature, widely used. Cons: extra
  package-manager layer given we already standardize on Bun.
- **Monorepo with Bun workspaces + Turborepo** — Bun as package manager/runtime, Turbo for
  task orchestration and caching.

## Decision

Bun workspaces + Turborepo. Workspaces are `apps/*` and `packages/*`; [[monorepo]] documents
the layout. `@lazyit/shared` holds shared contracts; apps depend on it via `workspace:*`.

## Consequences

- **Positive:** one repo, atomic changes, shared contracts with no publish step; Turbo gives
  cached `dev`/`build`/`lint`.
- **Trade-offs:** ties tooling to Bun's workspace behavior; some Node-only CLIs may need Node
  available (noted in [[stack]]).
- **Follow-ups:** see [[0009-bun-first-vs-app-stack]] for how far "Bun-first" extends into the
  app code.
