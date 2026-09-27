---
title: "ADR-0096: The api Jest suite stays CommonJS and transpiles the ESM-only NestJS packages"
tags: [adr, backend, testing, tooling]
status: accepted
created: 2026-09-02
updated: 2026-09-23
deciders: [Joaquín Minatel]
---

# ADR-0096: The api Jest suite stays CommonJS and transpiles the ESM-only NestJS packages

## Status

**accepted** — 2026-09-02 (issue #1273). Refines [[0012-testing-strategy]] (which chooses Jest
as the `apps/api` runner) and [[0009-bun-first-vs-app-stack]] (which pins Jest for the app layer
against the repo's `bun test` default). Neither is superseded: this record only says **how** that
Jest suite is configured now that its framework dependency is ESM.

## Context

NestJS 12 ships `@nestjs/common`, `@nestjs/core`, `@nestjs/testing`, `@nestjs/platform-express`
and `@nestjs/swagger` as **ES modules** (`"type": "module"`, no CommonJS build in the package).
`apps/api`'s suite is CommonJS — 171 spec files, 2841 tests, `ts-jest`, Jest's default
`transformIgnorePatterns` of `/node_modules/`.

On the v12 bump every suite that imports `@nestjs/testing` died at parse time:

```
node_modules/@nestjs/testing/index.js:7
export * from './interfaces/index.js';
SyntaxError: Unexpected token 'export'
```

129 of 171 suites failed. `tsc --noEmit` stayed clean throughout — this is a **runtime module-format
failure**, structurally invisible to the typechecker, which is why the dependency bump alone looked
healthy.

Two constraints shaped the answer:

- **Jest's CJS runtime does not use Node's `require(esm)`.** It resolves and compiles modules through
  its own registry. The v12 upgrade schematic warns that "Jest can only require() ESM modules on
  Node.js v24.9+"; that is not sufficient — reproduced failing on **Node v25.9.0 with jest 30.4.2**.
  The ESM has to be *transformed*, not merely permitted.
- **`ts-jest` structurally cannot transform it.** It downlevels the ESM `export`s correctly, but
  leaves `import.meta` untouched when emitting CommonJS, so `@nestjs/common/utils/load-package.util`
  then fails with `SyntaxError: Cannot use 'import.meta' outside a module`. SWC rewrites
  `import.meta.url` to `require('url').pathToFileURL(__filename).toString()`.

## Considered options

- **Native Jest ESM** (`--experimental-vm-modules`, `extensionsToTreatAsEsm`, `.js` import
  specifiers) — rejected: it changes module semantics under 171 spec files and every mocking idiom
  in them, for no behavioural gain.
- **Vitest** — what `nest upgrade` recommends and what new NestJS 12 projects default to. Rejected:
  [[0009-bun-first-vs-app-stack]] pins Jest for `apps/api` deliberately, and a runner swap is a far
  larger decision than an ESM dependency justifies. Left as a possible future ADR, not a
  consequence of this one.
- **`@swc/jest` for the whole suite** — measured; see below. Rejected on evidence.
- **`ts-jest` for the repo's `.ts`, `@swc/jest` for the ESM `.js`** — chosen.

## Decision

Keep the suite CommonJS. In `apps/api/package.json` (and, identically, `apps/api/test/jest-e2e.json`):

- `transformIgnorePatterns: ["/node_modules/(?!.*@nestjs)"]` — let the `@nestjs` paths reach a
  transform instead of being skipped. Everything else in `node_modules` stays untransformed.
- Two transform entries: `^.+\.ts$` → `ts-jest` (the repo's own code, unchanged), `^.+\.js$` →
  `@swc/jest` with `module.type: "commonjs"` (the ESM dependency, and only it).

`@swc/core` and `@swc/jest` become `apps/api` devDependencies. `ts-jest`'s floor moves to `^29.4.0`,
its first release supporting Jest 30.

**Measured**, three full runs each (171 suites / 2841 tests), cold / warm wall-clock:

| Configuration | Cold | Warm | Result |
| --- | --- | --- | --- |
| NestJS 11 + `ts-jest` (baseline) | 15.5s | 11.6s | green |
| NestJS 12 + `ts-jest` `.ts`, SWC `.js` | 15.4s | 11.6s | **green — chosen** |
| NestJS 12 + SWC everything | 13.1s | 9.6s | 1 suite / 7 tests red |

All-SWC is ~2s faster warm and **breaks `jest.spyOn(module, 'export')`**: SWC emits ESM namespaces
as non-configurable getters, so `smtp/email-dispatch.service.spec`'s spy on `buildTransport` throws
`Cannot redefine property`. Two seconds on a twelve-second suite does not buy rewriting specs and
changing transform semantics under all 171 of them.

## Consequences

- **Positive:** the suite is back to green at v11's wall-clock, with no change to any spec file and
  no change to the documented runner. SWC's blast radius is exactly the ESM `node_modules` that
  `ts-jest` cannot handle. Type-checking is not weakened — CI runs `tsc --noEmit -p
  apps/api/tsconfig.json` as its own blocking step, independent of the transform.
- **Preserve this:** `transformIgnorePatterns` is load-bearing. Deleting it, or narrowing the `.js`
  transform, brings back `SyntaxError: Unexpected token 'export'` on 129 suites. If another
  ESM-only dependency lands in the runtime import graph it must be added to the same negative
  lookahead.
- **Do not** promote `@swc/jest` to the `.ts` transform without first auditing every
  `jest.spyOn` on a module export.
- **Trade-offs:** two transformers in one Jest config, and a native binary (`@swc/core`) in the api
  devDependencies. `nest-cli.json` and the production build are untouched — this is a test-time
  concern only; the shipped app is still `nest build` → `tsc` → CommonJS `dist/`, which Node loads
  via `require(esm)` at runtime.
- **Follow-ups:** none required. Revisit only if `apps/api` itself moves to `"type": "module"`, or
  if the frontend/e2e runner decision deferred in [[0012-testing-strategy]] is taken up and makes a
  single runner attractive.

## Amendment — 2026-09-23: the AI SDK joins the lookahead (#1315)

The AI assistant (ADR-0097) adds the Vercel AI SDK 7 (`ai`, `@ai-sdk/*`), which is ESM-only, so the
lookahead is extended exactly as **Preserve this** above prescribes. Both `apps/api/package.json` and
`apps/api/test/jest-e2e.json` now read:

```json
"transformIgnorePatterns": ["/node_modules/(?!.*@nestjs|.*@ai-sdk|.*@workflow|(?:.*/)?ai/)"]
```

| Alternative | Why it is needed |
| --- | --- |
| `.*@ai-sdk` | `@ai-sdk/anthropic`, `/openai`, `/google`, `/openai-compatible`, `/provider`, `/provider-utils`, `/gateway` — all `"type": "module"` with import-only code |
| `.*@workflow` | `@workflow/serde`, imported by `@ai-sdk/provider-utils`; ESM-only (`Unexpected token 'export'` without it) |
| `(?:.*/)?ai/` | the `ai` package itself. Written this way so it matches at **every** `/node_modules/` in Bun's isolated store path (`.bun/ai@7…/node_modules/ai/…`) as well as a hoisted layout, and never matches `openai/` |

Each alternative was measured necessary by removing it and watching the compatibility specs die at
parse time. The rest of the AI SDK graph ships a CommonJS build and stays untransformed:
`eventsource-parser`, `@standard-schema/spec`, `undici`, `@vercel/oidc`, `json-schema` (types only).
The MCP SDK v2 (`@modelcontextprotocol/server`, `/node`, `/core`) is dual-published with a `require`
build and needs **no** entry. The regression tests that pin all of this live in
`apps/api/src/ai/providers/__compat__/`.

This remains a test-time concern: at runtime the compiled CommonJS `dist/` loads the AI SDK through
Node's `require(esm)`, which `__compat__/aisdk-require-esm.spec.ts` checks on the Node running the
suite.

