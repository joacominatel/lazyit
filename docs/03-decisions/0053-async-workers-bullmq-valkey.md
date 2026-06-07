---
title: "ADR-0053: Async workers — BullMQ on Valkey, with sandboxed processors"
tags: [adr, infra, async, queue, worker, security]
status: accepted
created: 2026-06-07
updated: 2026-06-07
deciders: [Joaquín Minatel]
---

# ADR-0053: Async workers — BullMQ on Valkey, with sandboxed processors

## Status

accepted — resolves the long-pending **"async workers"** ADR tracked in [[03-decisions/_MOC|Decisions]]
and the README gaps. Relates to [[0009-bun-first-vs-app-stack]] (the ioredis tension), [[0021-knowledge-base-design]]
(the import path), [[0025-containerization-strategy]] (a new backing service), and closes the structural
half of **SEC-002** (the `.docx` decompression bomb).

## Context

lazyit has, until now, deliberately had **no background worker**. A survey of the current codebase
confirms most async behaviour is intentional and should stay as-is:

- The **Zitadel mirror** (user create/update/delete) is **synchronous by design** — strong coupling with
  bounded retry, no split-brain ([[0043-zitadel-source-of-truth]]). Not a queue candidate.
- **Meilisearch** upserts/removes are **fire-and-forget** by design — a search outage must never fail an
  app write ([[0035-search-architecture]]). Not a queue candidate.

What *does* need a worker falls in two buckets:

1. **Hard drivers, now.**
   - **`.docx` import is a decompression-bomb vector (SEC-002).** A limit-compliant ~5 MB `.docx` can
     expand to GBs inside `mammoth`, OOM-ing the API. The compressed-size cap cannot bound expansion; the
     robust fix is to parse in a **memory-budgeted, isolated worker** so a bomb kills the worker, not the
     API. SEC-002's own triage (2026-05-25) deferred to "the future BullMQ/Redis worker" — this is it.
   - **Access-grant auto-expiry does not exist.** A grant past `expiresAt` stays active in the DB
     ([[access-grant]] notes a scheduler is needed). A recurring job is the natural home.
2. **The reason to build durable queueing at all** — two features are explicitly **parked, gated on this
   ADR** (§D of [[status_jun_2026/00-EXECUTIVE-SUMMARY|the June status]]): the **Applications workflow
   engine** (multi-step flows with parent/child dependencies) and **backups-from-frontend** (a long,
   restartable job whose loss on a crash matters). These — not the docx fix — are what justify a *durable*
   broker with flows, scheduling and rate-limiting, rather than an ad-hoc `setTimeout`.

Constraint from [[0009-bun-first-vs-app-stack]]: Bun is the tooling/runtime, but the **app layer is Node
(NestJS) + Prisma**. A queue client (ioredis) is not Bun-native; ADR-0009 flagged this as an accepted
drift *if* it stays in the app layer. The API already runs as a Node child of `nest start`, so this holds.

Product constraint: lazyit is **self-hosted, single-org, small-team, "boring durable technology."** Any new
backing service is real operational weight (one more container, volume, backup target, memory ceiling on a
single host). The bar for adding one is high.

## Considered options

### Queue library

- **pg-boss (Postgres-backed)** — **no new infra**: reuses the Postgres we already run. Strong fit for the
  "boring tech, one datastore" instinct. Rejected as the primary: no first-class **flows / parent-child
  dependencies** (the workflow engine's core need), weaker rate-limiting and a thinner NestJS/observability
  ecosystem. It would have to be replaced exactly when the workflow engine lands.
- **Bee-queue / custom `setTimeout` + table** — too thin; we'd rebuild retries, scheduling, flows and
  dashboards by hand. Rejected.
- **BullMQ** *(chosen)* — the de-facto Node queue: durable, retries+backoff, **delayed/repeatable jobs**
  (the expiry scheduler), **flows** (the workflow engine), rate-limiting, **sandboxed processors** (the
  SEC-002 isolation), a mature **first-class NestJS module** (`@nestjs/bullmq`), and tooling (bull-board).
  Cost: it requires a Redis-protocol server.

### Engine (the broker BullMQ talks to)

BullMQ **requires** a Redis-compatible server; it is a library *on top of* a broker, not a broker itself.

- **Redis (original)** — most documented, but relicensed to RSALv2/SSPL (2024). Fine for internal
  self-hosting, less clean if lazyit is ever packaged/redistributed as a service.
- **Dragonfly** — Redis-compatible, very fast. Newer, heavier defaults; overkill for a 5–20-person tool.
- **Valkey** *(chosen)* — the **Linux Foundation BSD-3 fork** of Redis 7.2. Wire-compatible (BullMQ's docs
  and ioredis treat it as Redis), drop-in `image:` swap, **clean redistribution licence**, low footprint.

### Memory/crash isolation for untrusted or heavy jobs

- **In-process worker (`@Processor` / `WorkerHost`)** — simplest, but a job's OOM crashes the API. Wrong
  for the docx bomb. Used only for *safe, light* jobs (e.g. expiry).
- **`worker_threads` with `resourceLimits`** — dep-free isolation; SEC-002 option (1). But we're adopting
  BullMQ anyway, so a bespoke thread pool is redundant.
- **BullMQ sandboxed processors** *(chosen for untrusted/heavy jobs)* — the processor lives in a separate
  file run in a **forked child process** (`@nestjs/bullmq`: `registerQueue({ processors: [file] })`).
  Combined with a Node heap cap (`--max-old-space-size`) on the child, a decompression bomb hits the cap
  and **crashes the child, not the API** → the job fails cleanly. This is SEC-002 options (1)+(2) together.

### Worker topology

- **Dedicated worker container** — full resource isolation, but doubles the deploy units now.
- **Co-located in the `api` container** *(chosen for now)* — the producer (Queue) and worker run in the
  same image/process group; sandboxed children fork from it. Simplest for a single-host deploy; the bomb is
  already isolated by the sandbox. **Split into a dedicated worker container later** when job volume or
  CPU-heavy flows justify it (a follow-up, not a blocker).

## Decision

Adopt **BullMQ on a self-hosted Valkey**, wired through **`@nestjs/bullmq`** with **ioredis** as the client
(app-layer only, per ADR-0009).

- **Valkey** is a new backing service in `compose.yaml`: **unprofiled** (so native `bun run dev` can use it)
  + under the **prod** profile, with **AOF persistence** (`appendonly yes`) so queued jobs survive a
  restart — durability is required for backups/workflow jobs even though the docx job wouldn't need it. It
  gets the shared logging anchor, a `mem_limit`/`cpus` ceiling, a named volume, and a `redis-cli ping`
  healthcheck; `api` gains `depends_on: valkey`. `compose.override.yaml` publishes `127.0.0.1:6379` for
  dev only (never exposed in prod, like the DBs — SEC-005/[[0028-secrets-and-config]]).
- **Connection** comes from env (`REDIS_URL`, with an `.env.example`); `BullModule.forRoot` reads it once.
- **Untrusted / memory-heavy jobs use sandboxed processors** with a child heap cap. **Safe, light jobs**
  (expiry, later) may use in-process `@Processor`.
- **Topology:** worker co-located in the `api` container for now.

**First job (the pilot of this epic): asynchronous article import.** `POST /articles/import` validates type
and size synchronously, enqueues the file, and returns **`202 { jobId }`**; the **`.docx` parse runs in a
sandboxed, memory-capped processor**; the web client **polls a status endpoint** until the article is ready
or the job fails. This closes the structural half of SEC-002 and exercises the whole pipeline end-to-end.

## Consequences

- **Positive:** unblocks the two parked features (workflow engine, backups-from-frontend); gives us a home
  for the missing grant-expiry scheduler; **closes SEC-002** (a docx bomb can no longer OOM the API); a
  NestJS-native, well-tooled async foundation we grow opportunistically.
- **Negative / trade-offs (accepted):**
  - **New infra: Valkey.** One more container, volume, memory ceiling and backup consideration on the
    single host — accepted because two real features require a durable broker and ad-hoc timers would be
    rebuilt-then-discarded.
  - **ADR-0009 drift:** ioredis (not Bun-native) enters the app layer. Scoped to api/worker only; the Bun
    tooling/scripts layer is untouched. Consistent with ADR-0009's "acceptable in the app layer" carve-out.
  - **Co-located worker** shares the api container's CPU/memory budget for now; sandboxed children still
    isolate the dangerous work. Splitting to a dedicated worker is a documented follow-up.
- **Follow-ups:** the **Applications workflow-engine** ADR (flows); the **backups-from-frontend** feature;
  the **grant auto-expiry** repeatable job; a **dedicated worker container** when load warrants; optional
  **bull-board** for queue observability. After the pilot lands, move SEC-002 to `06-security/closed/`.

Related: [[0009-bun-first-vs-app-stack]] · [[0021-knowledge-base-design]] · [[0025-containerization-strategy]] ·
[[0028-secrets-and-config]] · [[0035-search-architecture]] · [[0043-zitadel-source-of-truth]]
