---
title: "ADR-0014: Build @lazyit/shared to CommonJS + declarations"
tags: [adr]
status: accepted
created: 2026-05-25
updated: 2026-05-25
deciders: [Joaquín Minatel]
---

# ADR-0014: Build @lazyit/shared to CommonJS + declarations

## Status

accepted — supersedes the "no build, source-direct" stance previously noted in [[shared-package]].

## Context

`@lazyit/shared` originally exposed its TypeScript source directly (`main`/`types` →
`./src/index.ts`, no build), per [[shared-package]]. That held while the package was a single
self-contained file, but broke once it became multi-file: the NestJS API runs under **Node**
(`nest start` compiles to `dist/` and runs node), and Node executes the package's raw `.ts` as
an **ES module**, where extensionless relative re-exports (`export * from "./schemas/user"`)
fail resolution. No single import-extension style satisfies both consumers:

- Node's ESM resolution wants explicit `.ts` extensions.
- The API's *emitting* `tsc` build rejects `.ts` import extensions (`TS5097`, needs
  `allowImportingTsExtensions`, which forbids emit).
- `.js` specifiers do **not** resolve to `.ts` siblings under Node 26 (verified).

## Considered options

- **Build the package** — `tsc` → CommonJS + `.d.ts` in `dist/`; `main`/`types`/`exports` point
  at `dist/`. Standard monorepo pattern; runtime-agnostic; consumers get compiled JS + types.
- **Run the API under the Bun runtime** — Bun resolves extensionless TS natively (no build), and
  aligns with the Bun-as-runtime stance ([[0009-bun-first-vs-app-stack]]). But it changes the API
  run model and carries NestJS-on-Bun decorator-metadata risk.
- **Keep source-only** — not viable for a multi-file package consumed by the Node-compiled API.

## Decision

Build `@lazyit/shared` with `tsc -p tsconfig.build.json` to `dist/` (CommonJS + `.d.ts`).
`package.json`: `main` → `./dist/index.js`, `types` → `./dist/index.d.ts`, plus an `exports`
map. The base `tsconfig.json` stays no-emit (editor / Bun direct execution). Turbo orders the
build: `build`, `dev` and `test` tasks `dependsOn: ["^build"]`, so `api`/`web` always see a built
`shared`. Source stays organized as `src/{schemas,constants,utils}` with a barrel `index.ts`
(extensionless imports — CommonJS resolves them).

## Consequences

- **Positive:** robust and runtime-agnostic; the API consumes plain JS + types (no `.ts`-import
  friction); Turbo caches the build.
- **Trade-offs:** adds a build step to a previously source-only package; `dist/` must exist
  before running/testing the API (handled by Turbo `^build`); editing `shared` needs a rebuild.
- **Follow-ups:** add a watch (`tsc -w`) `dev` script to `shared` if we iterate on shared code
  frequently during `bun run dev`.

Related: [[shared-package]] · [[0009-bun-first-vs-app-stack]] · [[monorepo]] · [[0013-zod-validation-pipe]]
