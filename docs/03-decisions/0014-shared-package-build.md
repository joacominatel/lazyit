---
title: "ADR-0014: Build @lazyit/shared to CommonJS + declarations"
tags: [adr]
status: accepted
created: 2026-05-25
updated: 2026-06-14
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

### The `/crypto` subpath ships dual ESM/CJS (issue #429)

The main `.` barrel stays **CommonJS** — apps/api's CommonJS Jest loads it transitively across
most suites and must `require()` it cleanly. The `@lazyit/shared/crypto` subpath
([[0061-secret-manager-zero-knowledge]]) is the one exception: it re-exports the **ESM-only**
`@noble/*` packages (`"type": "module"`), so it ships **dual ESM/CJS** via the `exports`-map
conditions:

```jsonc
"./crypto": {
  "import":  { "types": "./dist/esm/crypto/index.d.ts", "default": "./dist/esm/crypto/index.js" },
  "require": { "types": "./dist/crypto/index.d.ts",     "default": "./dist/crypto/index.js" }
}
```

The build now runs **two `tsc` emits** (orchestrated by `scripts/build.ts`, the package `build`
script): the existing CJS pass (`tsconfig.build.json` → `dist/**`) **plus** an ESM pass of
`src/crypto` only (`tsconfig.crypto-esm.json` → `dist/esm/crypto/**`). A committed
`dist/esm/package.json` (`{"type":"module"}`) marks everything under `dist/esm/` as ES modules
while the package root stays CJS (no `"type"`). apps/web (the Next bundler) and bun's test runtime
take the `import` condition → real ESM, so they consume the **published subpath** rather than a
tsconfig `paths` alias to source (the v1 workaround, now removed). apps/api never imports
`/crypto` — the INV-10 packaging fence (`apps/api/src/secret-manager/inv-10.guard.spec.ts`) proves
it — so the CJS `require` branch exists only for completeness / non-bundler CJS consumers.

## Consequences

- **Positive:** robust and runtime-agnostic; the API consumes plain JS + types (no `.ts`-import
  friction); Turbo caches the build.
- **Trade-offs:** adds a build step to a previously source-only package; `dist/` must exist
  before running/testing the API (handled by Turbo `^build`); editing `shared` needs a rebuild.
- **Follow-ups:** add a watch (`tsc -w`) `dev` script to `shared` if we iterate on shared code
  frequently during `bun run dev`.
- **`/crypto` dual-build (#429):** the subpath now ships real ESM (`dist/esm/crypto/`) so apps/web
  consumes the published export, not a source alias — at the cost of a second `tsc` emit and a
  `dist/esm/package.json` marker. The ESM pass uses `moduleResolution: "Bundler"`, so its
  extensionless relative imports (`./params`, `./aead`) stay extensionless — fine for the only two
  consumers (bun + the Next bundler) but **not** Node's strict ESM loader; if a raw-Node ESM
  consumer ever appears, the crypto sources would need explicit `.js` import extensions.

Related: [[shared-package]] · [[0009-bun-first-vs-app-stack]] · [[monorepo]] · [[0013-zod-validation-pipe]]
