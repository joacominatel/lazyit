---
title: "ADR-0027: CI on GitHub Actions; CD deferred"
tags: [adr, infra, ci]
status: accepted
created: 2026-05-25
updated: 2026-05-25
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

- **Bun** is the pinned package manager (`bun@1.3.14`); install should be cached on `bun.lock`.
- The API unit specs **mock the generated Prisma client** (`jest.mock('../../generated/prisma/client')`)
  → **no database is needed in CI**. But the generated client must **exist** for compilation, so
  `prisma generate` must run **before** typecheck/test ([[0012-testing-strategy]]).
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
  setup-bun `1.3.14` → cache `~/.bun/install/cache` (key on `bun.lock`) →
  `bun install --frozen-lockfile` → build `@lazyit/shared` → **`prisma generate`** (in `apps/api`)
  → typecheck (`tsc --noEmit` per workspace) → **lint** (see below) → test (api Jest, no DB; shared
  `bun test`) → `turbo build` → **API boot smoke** (see below).
- **API boot smoke (#929).** After `turbo build`, `node -e "require('./dist/src/main.js')"` in
  `apps/api` requires the compiled entrypoint, so every module file's top-level import runs — the
  full `AppModule` require graph, exactly what `nest start` loads before `NestFactory.create`. A
  package imported at a module's top level but **missing from `apps/api` dependencies** (its types
  satisfied by an `@types/*` devDependency alone) throws `MODULE_NOT_FOUND` and fails CI instead of
  crashing the API at prod boot — the gap that let #927's undeclared `multer` pass tsc + Jest + the
  image build. The `require.main === module` guard in `main.ts` means `require()` does **not** call
  `bootstrap()`: no port bind, no Postgres/Valkey/Meilisearch connection (~1s). Run with `node`
  (not `bun`) to match the Node runtime `nest start` uses.
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

- **Positive:** consistent gate for humans and AI contributors; no DB needed (fast, simple);
  Dockerfile breakage is caught in CI; lint actually fails instead of silently rewriting; **new
  lint violations are blocked (diff-lint) without forcing a clean-up of the legacy backlog** (#591).
- **Trade-offs:** building three images per run adds minutes (mitigated by layer cache); CI lint
  diverges from the repo's `--fix` script by design — documented so contributors aren't surprised;
  the diff-lint gate needs full git history (`fetch-depth: 0`) and only covers `apps/api`/`apps/web`
  (the linted workspaces) — `packages/shared` has no eslint config, so it's not gated.
- **Follow-ups:** a CD ADR (publish to GHCR + deploy) once a target exists; consider a release
  workflow with semver tags then; promote the full-repo lint to blocking once the backlog is clean.

Related: [[0025-containerization-strategy]] · [[0012-testing-strategy]] · [[0015-deployment-model]] ·
[[deployment]] · [[setup]]
