---
title: "ADR-0052: Parallelize CI Docker builds (matrix) and decouple them from verify"
tags: [adr, infra, ci]
status: accepted
created: 2026-06-05
updated: 2026-06-05
deciders: [Joaquín Minatel]
---

# ADR-0052: Parallelize CI Docker builds (matrix) and decouple them from verify

## Status

accepted — refines [[0027-ci-pipeline]] (the original CI structure stands; this changes how the
`docker` job is scheduled and parallelized).

## Context

CI wall-clock was dominated by the `docker` job. Measured on recent `dev`/`master` runs
(`gh run view <id> --json jobs`):

| Run | `verify` | `docker` | critical path |
| --- | --- | --- | --- |
| 26977466846 | 111 s | **441 s** | ~552 s |
| 26982535043 | 104 s | 319 s | ~423 s |
| 26973507080 | 113 s | 240 s | ~353 s |
| 26982483634 | 108 s | 220 s | ~328 s |

Two structural costs explained the long pole:

1. **The three images built sequentially** as three steps in one `docker` job. Per-step on the
   slow run 26977466846: API **201 s**, Web **155 s**, migrate **56 s** → ~412 s *serial*. The job
   duration is the **sum** of the three builds even though they're independent.
2. **`docker` was gated on `verify`** (`needs: verify`), so the whole slow stage only *started*
   after the ~105 s verify job finished. The two never overlapped.

`verify` itself was already fast (~105 s) and well-cached (Bun install cache on `bun.lock`). One
remaining cold spot: Turborepo's local cache was **not** persisted across runs, so `turbo build`
always ran cold (~24 s, full web+api rebuild).

## Considered options

- **Keep the single sequential `docker` job** — simplest, but pays the full sum of three builds on
  the critical path, after waiting out `verify`. Rejected: this *is* the long pole.
- **Matrix-split the three image builds; keep `needs: verify`** — parallelizes the builds (job time
  → max instead of sum) but the stage still waits for `verify` first. A real win, but leaves the
  serial verify→docker wait on the table.
- **Matrix-split AND drop `needs: verify`** *(chosen)* — the three images build in parallel on
  three runners, and the `docker` matrix runs **concurrently with** `verify`. Critical path
  collapses to `max(verify, slowest single image)`.

## Decision

`.github/workflows/ci.yml`:

- **`docker` is a matrix job** over `image: [api, web, migrate]`, `fail-fast: false`. Each image
  builds on its own runner with `docker/build-push-action@v6` (`push: false`, per-image
  `type=gha` cache `scope=${{ matrix.image }}` — unchanged caching, just templated). All three
  Dockerfiles are still validated every run; `fail-fast: false` means one failing image does not
  cancel the others' diagnostics.
- **`docker` no longer declares `needs: verify`.** The image build and the quality gate run in
  parallel. `concurrency: cancel-in-progress` (per ref) still kills superseded runs.
- **`verify` persists Turborepo's cache** via `actions/cache` (path `.turbo`, keyed on
  `bun.lock` + `apps/**` + `packages/**` + `turbo.json`, with a `restore-keys` prefix), and runs
  `turbo build --cache-dir=.turbo` so the cached path matches. Turbo validates task inputs itself,
  so a stale entry is never reused incorrectly — at worst it rebuilds.

Everything else is preserved: digest-pinned base images, lint stays non-blocking
(`continue-on-error`), `prisma generate` before typecheck/test, the same typecheck + test + build
of all three workspaces, images still built but **not pushed** (CD still deferred — [[0027-ci-pipeline]]).

## Consequences

- **Positive:** estimated critical path drops from ~330–550 s to
  `max(verify ~105 s, slowest image ~130–200 s)` ≈ **130–200 s** — roughly a 55–65 % reduction,
  and larger on cold-cache runs. Image builds no longer wait out `verify`. Repeat `turbo build` is
  warm on a cache hit.
- **Trade-off (explicit):** dropping `needs: verify` means a run **spends Docker-build minutes even
  when `verify` fails** — the two no longer short-circuit each other. Accepted: fast feedback wins,
  the failure modes are independent (a broken Dockerfile is worth surfacing immediately regardless
  of a typecheck/test failure), `cancel-in-progress` bounds wasted minutes, and on hosted GitHub
  runners CI minutes are not the binding constraint here — wall-clock is.
- **Trade-off:** a matrix multiplies billed runner-minutes for the docker stage by 3 (three runners
  instead of one), but each runs for far less wall-clock. Net minutes are comparable; net *time* is
  much lower.
- **Follow-ups unchanged:** a CD ADR (publish to GHCR + deploy) once a target exists; promote lint
  to blocking once the codebase is eslint-clean without `--fix`.

Related: [[0027-ci-pipeline]] · [[0025-containerization-strategy]] · [[deployment]]
