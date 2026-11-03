---
title: Dependency upgrade — November 2026
tags: [development, dependencies]
status: accepted
created: 2026-11-02
updated: 2026-11-02
---

# Dependency upgrade — November 2026

Issue #1729 audits the direct dependencies in every workspace against registry metadata on
2026-11-02. Update stable releases together, preserving the existing app stack, shared contract,
production schema and stored data. The exact resolved graph lives in bun.lock.

## Compatibility exceptions

- **TypeScript stays 6.0.3.** Published ts-jest 29.4.15 requires TypeScript >=4.3 <7;
  typescript-eslint 8.72.1 requires >=4.8.4 <6.1.0. TypeScript 7.0.2 cannot replace it in this
  graph without changing the compiler/testing integration. Shared still uses node10 resolution,
  already marked for a separate TS7 preparation in tsconfig.build.json.
  [Supported compiler versions](https://typescript-eslint.io/users/dependency-versions/),
  [ts-jest package](https://github.com/kulshekhar/ts-jest/blob/main/package.json).
- **Prisma stays on the stable 7 line: 7.10.1**, aligned across CLI, client and adapter-pg.
  Registry latest for the CLI is 8.0.0-rc.29, a release candidate; introducing a prerelease ORM
  is outside this stable maintenance update. [Prisma releases](https://github.com/prisma/orm/releases).
- The lodash-es override remains 4.18.1, already latest. Existing exact crypto pins remain exact.

## Changes needing particular review

- **ESLint 9 → 10:** current Node 26 satisfies its runtime floor; the repo already uses flat
  config. Version 10 changes config lookup and recommended rules, removes legacy config and
  plugin APIs. Current typescript-eslint explicitly supports ESLint 10. Validate configuration
  on real source files as well as the test suite; do not weaken rules to accommodate the bump.
  [Migration guide](https://eslint.org/docs/latest/use/migrate-to-10.0.0).
- **NestJS 12.1 → 12.3:** the upstream release adds a native HTTP platform adapter and fixes
  middleware, streamed-file errors and SSE handling. lazyit keeps platform-express and the
  CJS/SWC Jest bridge from [[0096-jest-commonjs-against-esm-nestjs]].
  [Release notes](https://github.com/nestjs/nest/releases).
- **MCP server 2.1 → 2.4:** new skills/subscription extensions and optional resource-bound bearer
  verification; existing root exports remain supported. lazyit keeps its existing authorization
  and OAuth policy. [Changelog](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/server/CHANGELOG.md).
- **AI SDK 7 patch series:** provider/streaming/tool fixes and additive sandbox APIs. Existing
  provider and require(esm) compatibility tests remain the guard for the API runtime.
  [Core changelog](https://github.com/vercel/ai/blob/main/packages/ai/CHANGELOG.md).
- **BullMQ 6.3 → 6.5:** parent/child-flow fixes, dependency security fixes and node: imports;
  no queue namespace, worker processor or persisted job format change is introduced by lazyit.
  [Changelog](https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/changelog.md).
- **Mammoth 1.12.3 → 1.13.0:** moves Bluebird promises to native promises and improves Markdown
  escaping, custom XML and tracked revisions. lazyit awaits results without Bluebird methods.
  Keep the exact pin required by #1290; existing tests exercise convertToMarkdown with a real
  .docx fixture, so removal of the deprecated untyped API is visible at runtime.
  [Changelog](https://github.com/mwilliamson/mammoth.js/blob/master/NEWS).
- **Nodemailer 10.0 → 10.3:** adds OTP/header and SMTP result metadata and fixes MIME header
  handling. Existing SMTP dispatch tests cover lazyit usage.
  [Changelog](https://github.com/nodemailer/nodemailer/blob/master/CHANGELOG.md).
- Logging, image and shared validation packages stay on their current release families:
  [Pino API](https://github.com/pinojs/pino/blob/main/docs/api.md),
  [nestjs-pino releases](https://github.com/iamolegga/nestjs-pino/releases),
  [Sharp changelog](https://sharp.pixelplumbing.com/changelog/),
  [Zod releases](https://github.com/colinhacks/zod/releases).

## Upgrade behavior

No migration, schema change, data rewrite or operator configuration change. Existing rows,
secrets, permissions, sessions and queued work retain their application contracts. The Manual
needs no new feature instructions because this maintenance change adds no settings or user flow.

## Backend, shared and tooling version audit

| Workspace | Package | Before | After |
| --- | --- | --- | --- |
| lazyit | @anthropic-ai/claude-code | ^2.1.282 | ^2.1.316 |
| lazyit | @types/bun | ^1.4.2 | ^1.4.4 |
| lazyit | shadcn | ^4.21.0 | ^4.23.0 |
| lazyit | turbo | ^2.11.4 | ^2.11.10 |
| @lazyit/api | @ai-sdk/anthropic | ^4.0.63 | ^4.0.95 |
| @lazyit/api | @ai-sdk/google | ^4.0.80 | ^4.0.110 |
| @lazyit/api | @ai-sdk/openai | ^4.0.75 | ^4.0.107 |
| @lazyit/api | @ai-sdk/openai-compatible | ^3.0.55 | ^3.0.83 |
| @lazyit/api | @modelcontextprotocol/node | ^2.1.0 | ^2.1.2 |
| @lazyit/api | @modelcontextprotocol/server | ^2.1.0 | ^2.4.0 |
| @lazyit/api | @nestjs/common | ^12.1.0 | ^12.3.2 |
| @lazyit/api | @nestjs/core | ^12.1.0 | ^12.3.2 |
| @lazyit/api | @nestjs/platform-express | ^12.1.0 | ^12.3.2 |
| @lazyit/api | @nestjs/swagger | ^12.0.2 | ^12.1.0 |
| @lazyit/api | @node-rs/argon2 | 2.2.1 | 2.2.2 |
| @lazyit/api | @prisma/adapter-pg | ^7.10.0 | ^7.10.1 |
| @lazyit/api | @prisma/client | ^7.10.0 | ^7.10.1 |
| @lazyit/api | ai | ^7.0.114 | ^7.0.161 |
| @lazyit/api | bullmq | ^6.3.8 | ^6.5.4 |
| @lazyit/api | jose | ^6.2.12 | ^6.2.15 |
| @lazyit/api | mammoth | 1.12.3 | 1.13.0 |
| @lazyit/api | multer | ^2.4.0 | ^2.5.0 |
| @lazyit/api | nestjs-pino | ^5.2.1 | ^5.3.1 |
| @lazyit/api | nodemailer | ^10.0.10 | ^10.3.1 |
| @lazyit/api | pino | ^10.3.1 | ^10.4.0 |
| @lazyit/api | sharp | ^0.35.4 | ^0.35.5 |
| @lazyit/api | zod | ^4.6.5 | ^4.6.7 |
| @lazyit/api | @eslint/js | ^9.39.5 | ^10.0.1 |
| @lazyit/api | @nestjs/cli | ^12.0.7 | ^12.0.11 |
| @lazyit/api | @nestjs/schematics | ^12.0.5 | ^12.0.12 |
| @lazyit/api | @nestjs/testing | ^12.1.0 | ^12.3.2 |
| @lazyit/api | @swc/core | ^1.16.2 | ^1.16.21 |
| @lazyit/api | @types/multer | ^2.2.0 | ^2.3.0 |
| @lazyit/api | @types/node | ^26.6.2 | ^26.6.6 |
| @lazyit/api | dotenv | ^18.0.4 | ^18.0.9 |
| @lazyit/api | eslint | ^9.39.5 | ^10.14.0 |
| @lazyit/api | eslint-plugin-prettier | ^5.5.6 | ^5.5.7 |
| @lazyit/api | globals | ^17.12.0 | ^17.14.0 |
| @lazyit/api | pino-pretty | ^13.1.3 | ^13.2.0 |
| @lazyit/api | prettier | ^3.9.9 | ^3.9.10 |
| @lazyit/api | prisma | ^7.10.0 | ^7.10.1 |
| @lazyit/api | supertest | ^7.3.0 | ^7.3.1 |
| @lazyit/api | ts-jest | ^29.4.14 | ^29.4.15 |
| @lazyit/api | typescript-eslint | ^8.70.1 | ^8.72.1 |
| @lazyit/shared | zod | ^4.6.5 | ^4.6.7 |
| @lazyit/shared | @types/bun | ^1.4.2 | ^1.4.4 |
| @lazyit/fetch-cli | @types/bun | ^1.4.2 | ^1.4.4 |
| @lazyit/agent | @types/bun | ^1.4.2 | ^1.4.4 |

## Frontend version audit

| Package | Before | After |
| --- | --- | --- |
| @codemirror/autocomplete | ^6.20.3 | ^6.20.4 |
| @codemirror/language | ^6.12.4 | ^6.13.1 |
| @codemirror/view | ^6.43.13 | ^6.43.15 |
| @dagrejs/dagre | ^3.1.1 | ^3.1.3 |
| @hookform/resolvers | ^5.9.1 | ^7.0.1 |
| @hugeicons/core-free-icons | 4.3.5 | 4.4.0 |
| @tanstack/react-query | ^5.103.2 | ^5.105.3 |
| @xyflow/react | ^12.12.0 | ^12.12.1 |
| mermaid | ^12.0.0 | ^12.2.0 |
| next | 16.3.6 | 16.4.4 |
| next-intl | ^4.14.7 | ^4.14.9 |
| radix-ui | ^1.6.7 | ^1.8.1 |
| react | 19.3.0 | 19.3.1 |
| react-dom | 19.3.0 | 19.3.1 |
| react-hook-form | ^7.88.0 | ^7.91.0 |
| react-syntax-highlighter | ^16.1.1 | ^16.1.2 |
| shadcn | ^4.21.0 | ^4.23.0 |
| @tailwindcss/postcss | ^4.3.3 | ^4.3.4 |
| @types/node | ^26.6.2 | ^26.6.6 |
| eslint | ^9.39.5 | ^10.14.0 |
| eslint-config-next | 16.3.6 | 16.4.4 |
| tailwindcss | ^4.3.3 | ^4.3.4 |

## Frontend and runtime review

- **Next 16.3 → 16.4**, with eslint-config-next kept at the same exact version: upstream
  adds opt-in Cache Components improvements and changes Turbopack caching, production bundles
  and React 19.3 integration. No experimental/cache setting is enabled by this update.
  [Next 16.4 announcement](https://nextjs.org/blog/next-16-4).
- **Resolvers 5 → 7:** the breaking major releases concern Effect 4 and TypeBox 1 integrations.
  lazyit uses the Zod resolver, so those adapters are not consumed. Typechecking the actual form
  callers and testing schema behavior guard the Zod path.
  [Resolver releases](https://github.com/react-hook-form/resolvers/releases).
- **Mermaid 12.0 → 12.2** and **Radix 1.6 → 1.8:** retain the existing Markdown/diagram
  sanitization boundary and component wrappers; review upstream rendering and accessibility
  fixes. The repo defers browser component coverage per [[0012-testing-strategy]], so unit
  checks and a production build do not establish visual/browser equivalence.
  [Mermaid releases](https://github.com/mermaid-js/mermaid/releases),
  [Radix releases](https://www.radix-ui.com/primitives/docs/overview/releases).
- **Auth.js stays on its existing 5.0.0-beta.32 channel.** Registry latest points at v4;
  downgrading would contradict [[0039-authjs-v5-frontend-oidc]].
- **Bun 1.4.2 → 1.4.4:** keep packageManager, CI and Docker runtime pins aligned. Review the
  intervening [1.4.3](https://bun.com/blog/bun-v1.4.3) and
  [1.4.4](https://bun.com/blog/bun-v1.4.4) release notes. API Jest continues to run under Node
  as required by ADR-0096. The local verification uses the downloaded 1.4.4 binary without
  changing the developer global installation.

## Validation evidence

- API: 351 Jest suites, 8171 tests and 2 snapshots pass; this includes real Mammoth .docx
  conversion and the deprecated-method guard from #1290.
- Prisma 7.10.1 client generation, shared/API builds and shared/API/agent/demo-data
  typechecks pass. ESLint 10 successfully checks real API source (article-import.ts).
- Shared: 2818 tests pass. Fetch CLI: 4 tests pass. Both were also rerun under Bun 1.4.4.
- Agent under Bun 1.4.4: 581 pass, 2 fail. The two KeepToken static installer cases (trailing
  carriage return; tab before equals) reproduce on the exact origin/dev test, paths helper
  and install.ps1 copied to an isolated temporary fixture with **both** Bun 1.4.2 and 1.4.4
  (121 pass, the same 2 fail). This is a baseline failure, not introduced by the runtime bump;
  unrelated local installer edits are excluded from this dependency change.

## Validation evidence

On Bun 1.4.4: frozen install, Prisma generation, shared/API builds, shared/API/web/agent
typechecks and representative API/web ESLint 10 checks pass. Web production build under Node 26
passes (50 static pages generated); the first Bun-run wrapper stalled, so the verified build ran
the Next CLI directly under Node in hc. API Jest: 351 suites, 8,171 tests, two snapshots pass.
Shared: 2,818 pass; web: 2,543 pass; fetch CLI: four pass. Manual and message parity pass.

Agent: 581 pass and two existing KeepToken failures (trailing carriage return and whitespace
before `=`). Both reproduce with the exact origin/dev installer/test sources under Bun 1.4.2
and 1.4.4 (121 pass, two fail in the targeted installer suite). No installer source is changed
here. Docker builds, search wire tests and API boot checks remain CI validation.
