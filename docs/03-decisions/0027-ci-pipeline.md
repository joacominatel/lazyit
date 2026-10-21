---
title: "ADR-0027: CI on GitHub Actions; CD deferred"
tags: [adr, infra, ci]
status: accepted
created: 2026-05-25
updated: 2026-10-21
deciders: [Joaquín Minatel]
---

# ADR-0027: CI on GitHub Actions; CD deferred

## Status

accepted

## Context

There was no CI. We want every PR and every push to `master` to be gated by the same checks a
developer runs locally — install, typecheck, lint, test, build — plus a sanity build of the Docker
images ([[0025-containerization-strategy]]). We also need to decide whether to deploy automatically;
per [[0015-deployment-model]] there is **no deploy target** yet (self-hosted, installed by the
customer), so CD is premature.

Repo facts that shape the pipeline:

- **Bun** is the pinned package manager (`bun@1.4.2`); install should be cached on `bun.lock`.
- The API unit specs **mock the generated Prisma client** (`jest.mock('../../generated/prisma/client')`)
  → **the unit suite needs no database**. But the generated client must **exist** for compilation, so
  `prisma generate` must run **before** typecheck/test ([[0012-testing-strategy]]). The one exception
  is the Postgres-backed suite (`apps/api/test/*.db.spec.ts`, see below), which CI gives its own
  throwaway database.
- The api `lint` script is `eslint --fix`, which **mutates files and can mask failures**; a CI gate
  must run eslint **without `--fix`** so it reports rather than rewrites.
- e2e tests are deferred ([[0012-testing-strategy]]); CI runs **unit** tests only.

## Considered options

- **No CI / manual checks** — cheap, but lets regressions land on `master`. Rejected.
- **CI + automatic CD now** — would require choosing a host, a registry and deploy creds for a
  product with no deploy target yet. Premature and contradicts [[0015-deployment-model]].
- **CI now, CD deferred** *(chosen)* — gate quality on every PR/push; build images to prove the
  Dockerfiles compile, but **do not publish** them. Add CD when there is something to deploy to.

## Decision

`.github/workflows/ci.yml`, triggered on `pull_request` and `push` to `master` and `dev`:

- **Job `verify`** (ordered): checkout (`fetch-depth: 0`, for the diff-lint merge-base) →
  setup-bun `1.4.2` → cache `~/.bun/install/cache` (key on `bun.lock`) →
  `bun install --frozen-lockfile` → build `@lazyit/shared` → **`prisma generate`** (in `apps/api`)
  → typecheck (`tsc --noEmit` per workspace) → **lint** (see below) → test (api Jest, no DB; the
  **Postgres-backed API suite**; shared, web and agent with `bun test --isolate`) → `turbo build` →
  **API boot smoke** (see below).
- **Postgres-backed API suite (#1656).** `apps/api/test/*.db.spec.ts` (`bun run test:db`, config
  `test/jest-db.json`) covers what a mocked client cannot — today the raw-SQL notification grouping,
  time-zone day windows and mark-group-read ([[0056-in-app-notification-bell]]). `verify` starts
  `compose.yaml`'s `db` service detached at the top of the job — the same digest pin and Postgres major
  as production, read from the compose file rather than repeated in a GitHub `services:` block, so the
  two cannot drift (the search-wire job does the same for Meilisearch) — then, after the unit suite,
  waits on its healthcheck, runs `prisma migrate deploy` (the command production runs) and the suite
  with `DB_TEST_URL`. The suite fails, never skips, without `DB_TEST_URL`, and wipes the notification
  tables, so it only ever points at that ephemeral database. Credentials are a throwaway job-level
  value, not a secret.
- **`bun test --isolate` (#1318).** Without it every file of a `bun test` run shares one global and one
  module registry, and `mock.module(...)` lasts for the rest of the process and cannot be undone — a
  file that stubs a module leaks the stub into every later file, so a result depends on file order,
  which differs between macOS and Linux (it broke #1313). `--isolate` gives each file a fresh global
  and registry (Bun re-runs `--preload` per file and caches transpiled code across files). The flag is
  in the CI steps, in each workspace's `test` script and in the charter's validation list, so local
  runs match CI. **Rule:** a test may rely on isolation instead of restoring what it stubs; the
  `afterAll` restores added before isolation (8d05fc8c) stay — they are harmless and keep a file correct
  if it is ever run without the flag. Isolation is per file: tests inside one file still share state,
  so `--randomize` (which also reorders tests within a file) is not part of the gate.
- **API boot smoke (#929).** After `turbo build`, `node -e "require('./dist/src/main.js')"` in
  `apps/api` requires the compiled entrypoint, so every module file's top-level import runs — the
  full `AppModule` require graph, exactly what `nest start` loads before `NestFactory.create`. A
  package imported at a module's top level but **missing from `apps/api` dependencies** (its types
  satisfied by an `@types/*` devDependency alone) throws `MODULE_NOT_FOUND` and fails CI instead of
  crashing the API at prod boot — the gap that let #927's undeclared `multer` pass tsc + Jest + the
  image build. The `require.main === module` guard in `main.ts` means `require()` does **not** call
  `bootstrap()`: no port bind, no Postgres/Valkey/Meilisearch connection (~1s). Run with `node`
  (not `bun`) to match the Node runtime `nest start` uses.
- **Module-graph compile (#1628).** The smoke never runs Nest's dependency resolution, and unit specs
  list their providers by hand, so a controller injecting a provider its module does not import used to
  pass CI and crash at real boot ("Nest can't resolve dependencies of …"). `apps/api/src/app.module.spec.ts`
  compiles the whole `AppModule` in the api Jest step (~2s). Only external I/O is mocked (the generated
  Prisma client and its pg adapter, ioredis, BullMQ, Meilisearch, `jose`); every app-owned provider
  resolves from its real module, so a removed module import fails CI.
- **Lint is two-tier (#591).** Full-repo `eslint .` per app is **report-only**
  (`continue-on-error: true`) because the codebase is not yet eslint-clean — it keeps the legacy
  backlog visible without failing CI. A separate **blocking** "Lint changed files" step lints
  **only the files changed vs the merge-base with `origin/dev`** (`git diff` filtered to
  `.ts/.tsx/.js/.jsx/.mjs/.cjs`, split per app, piped to each app's eslint with
  `--no-error-on-unmatched-pattern`; no changed files → exit 0). A NEW violation in changed code
  fails CI; the legacy backlog stays exempt. The diff **is** the ratchet — no baseline file.
  Promote the report-only step to blocking (drop `continue-on-error`) once the backlog is clean.
- **Job `docker`** (needs `verify`): build the three images with `docker/build-push-action`,
  **`push: false`**, GHA layer cache — proves the Dockerfiles build. No DB, no registry.
  > **Updated by [[0052-ci-parallel-docker-and-decoupled-verify]]:** `docker` is now a parallel
  > **matrix** (one runner per image) and **no longer `needs: verify`** — it runs concurrently with
  > the gate. Everything else here still holds.
- **CD: deferred.** No deploy step. When CD lands, the registry is **GHCR** (GitHub-native, free for
  the repo) — a follow-up ADR will define the publish/deploy flow and image tagging (commit SHA +
  semver).

## Consequences

- **Positive:** consistent gate for humans and AI contributors; the unit suite needs no DB (fast,
  simple), and the SQL that a mock cannot check runs against the production Postgres major;
  Dockerfile breakage is caught in CI; lint actually fails instead of silently rewriting; **new
  lint violations are blocked (diff-lint) without forcing a clean-up of the legacy backlog** (#591).
- **Trade-offs:** building three images per run adds minutes (mitigated by layer cache); the
  Postgres suite adds a container and a migrate to `verify` (the boot overlaps install and typecheck);
  `--isolate` re-evaluates each file's imports, measured at about +1–6 s per `bun test` suite; CI lint
  diverges from the repo's `--fix` script by design — documented so contributors aren't surprised;
  the diff-lint gate needs full git history (`fetch-depth: 0`) and only covers `apps/api`/`apps/web`
  (the linted workspaces) — `packages/shared` has no eslint config, so it's not gated.
- **Follow-ups:** a CD ADR (publish to GHCR + deploy) once a target exists; consider a release
  workflow with semver tags then; promote the full-repo lint to blocking once the backlog is clean.

Related: [[0025-containerization-strategy]] · [[0012-testing-strategy]] · [[0015-deployment-model]] ·
[[deployment]] · [[setup]]
