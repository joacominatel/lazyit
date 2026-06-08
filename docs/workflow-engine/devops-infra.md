---
title: "Workflow Engine — DevOps / Infrastructure & Operability"
tags: [workflow-engine, devops, infra, async, queue, valkey, bullmq, operability, design]
status: proposed
created: 2026-06-07
---

# Workflow Engine — DevOps / Infrastructure & Operability

> Area design doc for the **Applications workflow engine** (CEO vision: per-application,
> opt-in provisioning/deprovisioning workflows triggered by access grant/revoke). This note
> covers **only the DevOps / operability lens**: execution substrate, the single-host
> footprint, backups, observability, worker topology, resource limits, failure/restart
> behavior, secrets-at-rest mechanics, and the **outbound egress / network posture**. It does
> not design the data model, the API, or the integration-type schemas (other area docs own
> those). No code, no schema, no migrations here.
>
> **The load-bearing test applied throughout:** does it preserve *one `docker compose up`* for
> an IT-generalist operator who "knows Docker barely"
> ([[product-vision-tech|product vision: target operator profile]])?

---

## 0. TL;DR — the substrate verdict from the ops chair

**Adopt BullMQ on a self-hosted Valkey, exactly as already decided in
[[0053-async-workers-bullmq-valkey|ADR-0053]] — do NOT introduce a second substrate for this
engine.** The workflow engine is one of the two features ADR-0053 cites as the *reason that
durable broker exists at all*; it should ride that container, not add its own.

Concrete ranking on the **operator-simplicity axis** (the axis this lane weights most):

| Option | New containers | New backup target | New datastore | Load-bearing test | Verdict |
| --- | --- | --- | --- | --- | --- |
| **pg-boss** (reuse existing Postgres) | **0** | **0** (already in `pg_dump`) | 0 | ✅ best | Strong runner-up; the *pure* ops winner |
| **BullMQ + Valkey** (ADR-0053) | **1** | 0 (kept transient — see §4) | 1 (KV) | ✅ preserved | **Chosen** |
| **Temporal** (server + own DB + UI) | **3+** | 1 (a *third* DB) | 1 (3rd DB) | ❌ violated | Reject |
| **n8n** (separate product) | 2+ (app + DB) | 1 | 1 | ❌ violated + governance split | Reject |
| **Synchronous** (no infra) | 0 | 0 | 0 | ✅ but wrong shape | Reject for the call path; keep as the no-workflow path |

Honest nuance: if we were choosing clean today, **pg-boss would win the literal load-bearing
test** (zero new infra, jobs land in the already-backed-up Postgres). The deciding factor is
**not** ops preference — it is that (a) ADR-0053 is already *accepted* and fragmenting the stack
into two job substrates is worse than one slightly-heavier one, and (b) the engine genuinely
needs **flows / parent-child steps, delayed+repeatable jobs (timer triggers), and a dashboard**,
which pg-boss does not give first-class (ADR-0053 §"Queue library"). So: **Valkey wins, but only
because the org already paid for it and the capability is real** — and only if the seven
guardrails in §11 hold. Temporal and n8n are firm rejects on the single-host operator profile.

**Status of the substrate in the repo today:** ADR-0053 is *accepted* but **not yet wired** —
there is no `valkey`/`redis` service in `compose.yaml` and no queue dependency in the code
(verified: no `bullmq`/`ioredis`/`valkey` references outside docs). So the first infra task is
**landing the ADR-0053 Valkey service once**, and the engine builds on it. See §3 and §12.

---

## 1. The operational baseline we must not break

The current single-host topology (`compose.yaml` + `compose.override.yaml` for dev +
`infra/docker-compose.prod.yaml` for the prod overlay) is already **dense**. Long-running
services and their ceilings:

| Service | Image | `mem_limit` | `cpus` | Profile | Backed up? |
| --- | --- | --- | --- | --- | --- |
| `db` (app Postgres 18) | `postgres:18-alpine` | **1g** | 1.5 | unprofiled | YES (`pg_dump`) |
| `zitadel_db` (Postgres 16) | `postgres:16-alpine` | 256m | 0.5 | unprofiled | YES (`pg_dump`) |
| `zitadel` (IdP) | `zitadel:v2.68.0` | 512m | 1.0 | unprofiled | via its DB |
| `meilisearch` | `meilisearch:v1.12.3` | 512m | 1.0 | unprofiled | NO (rebuildable) |
| `api` (NestJS/Node) | built | 512m | 1.0 | prod | n/a |
| `web` (Next.js/Node) | built | 256m | 0.5 | prod | n/a |
| `caddy` | `caddy:2-alpine` | 128m | 0.5 | prod | NO (re-issuable) |
| `backup` (opt-in) | `postgres:18-alpine` | 256m | 0.5 | prod+backup | n/a |

Plus three one-shots (`migrate`, `zitadel-secrets-init`, `zitadel-bootstrap`).

**Two facts dominate every decision below:**

1. **The host is small and already crowded.** `docs/05-runbooks/deploy-self-hosted.md` §6
   recommends a *minimum* of **2 vCPU / 4 GB RAM / 20 GB disk**. The sum of the long-running
   `mem_limit` ceilings above is already ~**3.2 GB** on a 4 GB box — headroom is thin *before*
   we add anything. This is the single hardest constraint on the substrate choice. It is why
   **+1 container (Valkey, ~64–128 MB)** is acceptable and **+3 containers (Temporal)** is not.
2. **There are already TWO Postgres instances and TWO DR items.** The operator already has to
   reason about `db_data` vs `zitadel_db_data`, two `pg_dump`s, and the `ZITADEL_MASTERKEY`
   linchpin (`docs/05-runbooks/backups.md`). Adding a **third** datastore (Temporal's) is a real
   cognitive + DR tax. Adding a KV that we deliberately treat as **rebuildable** (like Meili) is
   nearly free.

The established compose conventions any new service MUST follow (they are the operability
contract — see the `compose.yaml` header and `lazyit-devops` skill §4):

- **Digest-pinned image** (`@sha256:…` beside the human tag).
- **`x-logging: *default-logging` anchor** (json-file, 10m×3) so logs can't fill the disk.
- **`mem_limit` + `cpus` ceiling** so one runaway service can't OOM/CPU-starve the host.
- **Healthcheck** + `depends_on: { condition: service_healthy }` gating.
- **Named volume** for any state; **`internal` network only**; **only Caddy publishes ports**.
- **Dev override** publishes a loopback port (`127.0.0.1:…`) and drops the ceilings.

---

## 2. What the engine actually demands of a substrate

From the CEO vision, the execution substrate must support:

- **Two triggers now:** access *granted* and access *revoked*. The enqueue points are
  `apps/api/src/access-grants/access-grants.service.ts` (`create()` and `revoke()` /
  `batchRevoke()`). These are **low-volume, low-fan-out** events — an IT team of 2–20 grants
  access a handful of times a day, not thousands per second. *Throughput is not the problem;
  durability, retries, and visibility are.*
- **Later: timer / scheduled triggers** (N days after grant, periodic re-certification) →
  **delayed + repeatable jobs** (BullMQ has these natively; this is also the home of the
  long-deferred grant-expiry scheduler — [[0023-access-management-design|ADR-0023]] "Deferred",
  ADR-0053 bucket 1).
- **Multi-step workflows with ordering / dependencies** (create user → assign team → notify) →
  **flows / parent-child jobs** (the capability that ruled out pg-boss as ADR-0053's primary).
- **Durable, restartable runs** — a half-finished provisioning run must survive an API restart
  and not silently vanish (this is *why* a durable broker over `setTimeout` — ADR-0053 §Context).
- **Outbound calls to arbitrary external systems** (REST, webhook, SDK, MCP) — the operational
  hard part, covered in §7 (egress) and §8 (secrets).
- **Manual steps** — a human action / data entry, surfaced in an **inbox**. Ops-wise this reuses
  the ADR-0052 **Notification + in-app bell + SSE** stack (see §9), no new infra.

Crucially: **if no workflow is configured for an application, granting access is exactly today's
synchronous `AccessGrant` write** — the engine adds *zero* runtime cost to the default path. The
substrate is only touched when a workflow exists for that app+trigger.

---

## 3. The substrate options, judged on operability

### 3.1 BullMQ + Valkey — CHOSEN (rides ADR-0053)

**What it adds:** one container (`valkey`), one named volume, one `REDIS_URL` env var, one
`depends_on` edge. Wire-compatible Redis fork under a clean BSD-3 license (ADR-0053 §Engine).
`@nestjs/bullmq` is a first-class NestJS module; `ioredis` is the client (the accepted ADR-0009
app-layer drift — see [[0009-bun-first-vs-app-stack|ADR-0009]] §"Revisit `Bun.redis` vs `ioredis`
when choosing BullMQ").

**Why it passes the load-bearing test:** Valkey slots into the *existing single compose file* as
one more unprofiled+prod service following every convention above. `docker compose up` still
brings the whole stack online with one command; the operator never learns a new tool — it's "a
small in-memory thing the app uses for background jobs," health-checked and capped like
everything else.

**What I would add to compose** (illustrative shape — *describing the fields*, not committable
config; the actual service lands with the ADR-0053 implementation PR, then the engine reuses it):

- service `valkey`, **unprofiled** (so native `bun run dev` can reach it) — mirrors how `db` /
  `meilisearch` are unprofiled.
- image `valkey/valkey:8-alpine`, **digest-pinned** with the tag in a comment (ADR-0025 pinning).
- `command` enabling append-only persistence (`--appendonly yes`) — but see the §4 nuance: for
  *this engine* AOF is a crash-resilience nicety, **not** a system-of-record.
- `logging: *default-logging`; `mem_limit: 128m`; `cpus: 0.5` (a 5–20-person tool's queue is tiny).
- named volume `valkey_data:/data`; `networks: [internal]`; **no published port** in prod.
- `healthcheck`: `valkey-cli ping` (the shell-equipped alpine image supports it — unlike Zitadel).
- `api` gains `depends_on: { valkey: { condition: service_healthy } }`.
- `compose.override.yaml` publishes `127.0.0.1:6379:6379` for dev + drops the ceiling (the same
  loopback-only pattern as `db`/`meili`/`zitadel`, SEC-005 / [[0028-secrets-and-config|ADR-0028]]).
- `REDIS_URL` added to `apps/api/.env.example` and `infra/env/.env.prod.example` (ADR-0028).

**Cost, honestly:** +1 container, +1 volume, +~128 MB ceiling, and the AOF/DR question in §4. On
a 4 GB host this is absorbable; combined with a *dedicated worker* container later it is not —
see §6 and the host-sizing bump in §10.

### 3.2 pg-boss — the runner-up that best honors the operator profile

**What it adds:** *nothing* — it is a set of tables in the **existing app Postgres**. Zero new
container, zero new volume, zero new healthcheck, zero new memory ceiling, and the jobs are
**already covered by the `pg_dump` backup sidecar** (`compose.yaml` `backup`). On the literal
load-bearing test, pg-boss is the **winner**.

**Why we don't pick it anyway:** (a) ADR-0053 already chose Valkey for the org and shipping a
*second* substrate just for this engine is the worse operational outcome (two things to
understand, not one); (b) the engine wants **flows/parent-child** and **rate-limiting** and a
**dashboard**, which pg-boss is thin on (ADR-0053 §Queue library). (c) Long-running jobs holding
Postgres connections/advisory locks compete with the app's own connection budget on the same
1 GB `db` — a subtle contention pg-boss makes easy to hit.

**Where pg-boss stays relevant:** as the **explicit fallback** if the CEO wants to *defer* Valkey.
At v1 scope (two low-volume triggers, simple linear steps) pg-boss could carry the engine, and the
flows gap is survivable by modeling steps as a small state machine in Postgres. I'd accept pg-boss
for v1 *only* under a "no Valkey yet" directive — and I'd flag that timer triggers + true flows
later would still pull us toward Valkey, i.e. we'd migrate exactly when ADR-0053 predicted.

### 3.3 Temporal — REJECT on the operator profile

Temporal is a genuinely excellent durable-workflow engine, and feature-wise it maps to this
problem better than anything. **It is also the clearest violation of the operator profile in this
whole comparison.** Honest accounting of what self-hosting Temporal puts on a 2-vCPU/4-GB box run
by an IT generalist:

- The **Temporal server** is itself multiple internal services (frontend, history, matching,
  internal worker) — even the "auto-setup" single image is a heavyweight relative to everything
  else in our stack.
- It needs **its own persistence store** (Postgres/MySQL or Cassandra) → a **THIRD database** to
  provision, schema-migrate (`temporal-sql-tool`), back up, and reason about in DR. We just spent
  ADR-0037/0043 keeping Zitadel's DB *separate and removable*; Temporal would add another.
- The **Temporal Web UI** is a further container.
- A new operational vocabulary (namespaces, task queues, workflow/activity versioning,
  sticky queues, the "non-determinism" replay model) that an IT generalist must not be required to
  learn to run an asset/access tool.

Net: **+3 containers, a 3rd datastore, a 3rd DR item, +>1 GB RAM**, and a steep concept curve —
to automate what is, at our scale, a handful of provisioning calls per day. This breaks
"one `docker compose up` that an IT generalist can operate." **Reject.** (If lazyit ever grows a
managed/SaaS tier with a platform team, revisit — but that contradicts
[[product-vision-tech|self-hosted-primary]].)

### 3.4 n8n — REJECT (it's a second product, not a substrate)

n8n is the closest thing *feature-wise* to the CEO's "configurable per-app workflows" picture, and
that is exactly the trap. Operationally it is **another full application** (its own service + its
own DB) with its own UI, its own auth, its own credential store, and its own update cadence.
Adopting it would:

- **Fork the governance story.** ADR-0046/0048 + `docs/06-security/INVARIANTS.md` (INV-8, INV-SA-*)
  put authZ, audit, and secrets *inside lazyit, DB-first*. n8n would hold credentials and run
  history *outside* that model — a split-brain audit trail and a second RBAC system, which is
  precisely what the workflow engine's governance requirement (reports/audit gated by the RBAC
  catalog) forbids.
- **Add a DB + a UI container** and a "learn n8n" tax on the operator.

**Reject as the engine substrate.** (It could be a *target* an admin integrates *with* via a
webhook/REST step — that's fine and is just another egress endpoint, not our substrate.)

### 3.5 Synchronous (no infra) — the correct *default*, wrong for the call path

For an app with **no workflow configured**, execution *is* synchronous and adds nothing — keep
that path exactly as today. But running an *external provisioning call* synchronously inside the
grant request is wrong: a slow/hung Jira API would block the request thread and the operator's UI,
and you'd have to hand-roll retries/backoff/durability. Most importantly, it would tempt copying
**Zitadel's strong-coupling** ([[0043-zitadel-source-of-truth|ADR-0043]] §3, INV-5: a Management
failure rolls back + 503). **The workflow engine must NOT copy that.** A failing *external*
provisioning call must **not** roll back or block the local `AccessGrant` — the grant is the
source of truth; provisioning is a best-effort, ret, observable side effect. That decoupling is
the whole reason an async substrate exists here. (Contrast noted explicitly because ADR-0043 is a
precedent the engine will be tempted to mirror — and must not.)

---

## 4. Backups & durability — keep Valkey *rebuildable*, not a system of record

This is the most important ops decision after the substrate itself, and it is where I **partly
challenge ADR-0053**.

ADR-0053 enables **AOF persistence** ("so queued jobs survive a restart"). That's fine for the
*docx-import* pilot. For the **workflow engine specifically**, I recommend a stricter posture:

> **Valkey holds only in-flight, reconstructable job state. The durable system of record for a
> workflow run — its definition, status, per-step result, manual-task state, and audit trail —
> lives in the app Postgres** (already backed up by the `pg_dump` sidecar).

Consequences, all of which *protect operator simplicity*:

- **No new backup target.** Valkey is treated like Meilisearch in `docs/05-runbooks/backups.md`:
  **rebuildable, not backed up.** The DR inventory table stays at its current four items; the
  operator does not learn AOF/RDB snapshotting.
- **A Valkey wipe is recoverable.** If the volume is lost, no run *data* is lost — at worst some
  in-flight runs need **reconciliation/replay** from their Postgres run-state. Document a simple
  "re-enqueue runs stuck in `RUNNING`" reconcile path (a maintenance command), analogous to
  Meili's `reindex:all`.
- **AOF is then a convenience, not a guarantee.** Keep `--appendonly yes` (cheap, shrinks the
  restart-replay window) but the *correctness* guarantee comes from Postgres, not AOF. This means
  even an `RDB`-only or `--save ""` Valkey would be *safe*, just slightly more replay on restart.

This keeps the backup story **unchanged** (two `pg_dump`s, one masterkey) — a hard win for the
"IT generalist" operator — while still giving durable, restartable runs.

---

## 5. Observability & monitoring

| Substrate | Built-in UI | Our posture |
| --- | --- | --- |
| BullMQ + Valkey | **bull-board** (3rd-party, read-only queue dashboard) | Mount it **internal-only, behind Caddy + RBAC** (`settings:manage` / a new `workflow:*` permission, §11). Never public, never its own published port. |
| Temporal | Temporal Web UI (rich) | n/a (rejected) — its richness doesn't justify its footprint at our scale |
| pg-boss | none | Would mean ad-hoc SQL queries — a real operability gap |

bull-board is the right *level* of observability for this operator: a page showing
queued/active/failed/completed jobs and letting an admin retry a failed run, reachable through the
existing reverse proxy with the existing session — no new tool to install. Concretely:

- **Reuse the existing logging contract** ([[0031-logging-strategy|ADR-0031]]): every job logs
  via Pino with the triggering request's **`X-Request-Id`** propagated into the job payload as a
  correlation id, so a run is traceable end-to-end (UI toast → API → worker → external call WARN).
  **Bodies and secrets are never logged** (ADR-0031 + **INV-6**) — the per-step external payload
  and any credential are logged by *reference/redaction only*. This mirrors how the Zitadel
  management client was made request-correlatable in issue #219 (ADR-0043 note).
- **Run status to the operator** reuses ADR-0052's **SSE bell** (a run completed/failed
  notification), so the operator sees results without watching bull-board.
- **Health:** the engine's liveness is the api/worker container healthcheck + Valkey's
  `valkey-cli ping`; no new monitoring stack (Prometheus etc.) — that would violate the profile.

---

## 6. Worker topology — co-located now, dedicated container next

ADR-0053 chose a **co-located worker** (Queue + worker in the `api` container; sandboxed children
fork from it) for now, splitting later "when job volume or CPU-heavy flows justify it."

For the **workflow engine** I refine the trigger to split, because the engine's workload differs
from the docx pilot in a way that matters operationally:

- **The danger is hung/slow OUTBOUND I/O, not CPU/memory.** A workflow step calls an arbitrary,
  possibly-slow or possibly-hung external API. Many concurrent hung calls inside the `api`
  container consume its event-loop attention, sockets, and memory ceiling (512m) — degrading the
  app the operator is actively using. (The docx bomb was a *memory* risk solved by sandboxing; a
  hung HTTP call is a *liveness/isolation* risk solved by a separate process.)
- **Egress controls are far easier to scope to a dedicated container** (§7). You cannot put the
  `api` on a locked-down egress network — it must reach Zitadel, the DBs, Meili. A **dedicated
  `worker` container can sit on a separate, egress-restricted network**, which is the clean place
  to enforce SSRF network policy.

Recommendation:

- **v1:** co-located worker in `api` (per ADR-0053) to keep the footprint at +1 container (Valkey
  only). Acceptable because v1 volume is tiny and the *app-layer* SSRF guard (§7) is the primary
  control regardless of topology.
- **v1.5 / Phase 2 (recommended early):** split into a **dedicated `worker` container** (prod
  profile; same built image as `api`, different entrypoint) **specifically to get
  network-level egress isolation**, not for throughput. If the security lane requires
  network-segmented egress for v1, **bring this split forward into v1** — flag in §11.
- The dedicated worker is the point at which the **host should grow to 6–8 GB** (§10): a second
  Node runtime is another ~256–512 MB ceiling, and that, not Valkey, is what strains a 4 GB box.

---

## 7. Egress / network posture — the real operational hazard (coordinate with security)

This is where the workflow engine differs most from everything lazyit has built so far: it makes
**outbound calls to URLs an admin configures**. That is a textbook **SSRF** surface, and it
overlaps the security lane — this section states the *ops/network* half and flags the dependency.

Today the `internal` bridge network has **no egress policy** and every app service shares it. If a
worker on `internal` blindly fetches an admin-supplied URL, that URL could point at:

- **Our own internal services** — `db:5432`, `zitadel_db:5432`, `zitadel:8080`, `meilisearch:7700`
  — none of which require auth from inside the network. A malicious/mistyped workflow target could
  read or poke them.
- **Cloud metadata** (`169.254.169.254`), loopback, link-local, and other RFC1918 hosts on the
  operator's LAN.

Ops-side controls I recommend (defense in depth; the app-layer guard is mandatory, the
network-layer one is the strong form):

1. **App-layer SSRF allow/deny guard (mandatory, owned with security).** Before any outbound
   call, resolve the host and **deny by default** anything in loopback / link-local / RFC1918 /
   the metadata IP, and **deny our own service names/subnet** (`db`, `zitadel`, etc.). Be
   **DNS-rebinding-safe** (resolve once, connect to the resolved IP, re-validate). This holds
   regardless of worker topology, which is why v1 can co-locate.
2. **Network-layer isolation (strong form, enables the §6 split).** Put the **dedicated worker on
   a separate network that has egress to the internet/LAN-of-targets but NOT to the `internal`
   service network.** Docker can't do per-rule egress firewalling natively, so the practical
   self-hosted shape is: worker on its own bridge, *not* attached to `internal` for the services
   it must not reach, plus the app-layer guard. Document the limitation honestly — true egress
   firewalling (e.g. an operator-provided proxy allow-list) is an *optional advanced* posture, not
   a default we can guarantee on plain Docker.
3. **Per-app outbound allow-list as config.** The admin configures the target base URL per app;
   the engine should treat that as the *only* permitted destination for that app's steps
   (an allow-list, not free-form per-step URLs), which also doubles as the SSRF allow-list.
4. **Disconnected operation holds** ([[product-vision-tech|anti-goals]]): the engine calls *out*
   to the external apps it integrates with and **never phones home to us**. No inbound dependency
   on our infra. If a customer is fully air-gapped, workflows that target internet apps simply
   fail-soft and surface as failed runs (observable, retryable) — they never block the local grant.

> **Hard dependency on the security lane.** The exact deny-list ranges, the DNS-rebinding
> mitigation, and whether network-segmented egress is *required* for v1 (forcing the §6 split
> early) are security calls. This doc commits the *infra mechanics* (a separable worker network,
> internal-only services, no new public port); security owns the *policy*.

---

## 8. Secrets at rest — reuse ADR-0052's encrypted `SystemSecret`, never env, never the payload

Per-app credentials (Jira API token, OAuth client secret, webhook signing key) are the engine's
most sensitive new data. The mechanics are already solved by **ADR-0052** (on branch
`feat/settings_notifications_smtp`, summarized in
`.claude/skills/lazyit-cto/references/decision-history.md`): an **encrypted `SystemSecret`** store
with a **redacted `SettingAuditLog`**. The engine **must reuse it**:

- **Store per-app credentials as encrypted `SystemSecret` rows in Postgres** (encrypted at rest),
  *not* as new `.env`/compose env vars (which don't scale per-app and aren't rotatable per-app) and
  *not* in `Application.metadata` jsonb (that's unencrypted — ADR-0023 "Deferred").
- **The job payload in Valkey references a secret by id; it never contains the cleartext.** The
  worker resolves + decrypts the secret **at execution time**, in-process, and discards it. This
  keeps secrets out of Valkey (and out of any AOF file / RDB snapshot / bull-board view).
- **INV-6 + ADR-0031 are absolute here:** the credential is never logged, never echoed in a run's
  audit row, never surfaced in bull-board. The audit trail records *that* a secret was used (by
  ref), not its value — the same pattern as ADR-0052's redacted `SettingAuditLog` and the Zitadel
  SA key (INV-6).
- **The encryption key** follows ADR-0052's mechanism (its key, not a new one). Document it as a
  **DR linchpin** in `docs/05-runbooks/backups.md` alongside `ZITADEL_MASTERKEY` — losing it makes
  the encrypted per-app credentials unreadable (same failure mode, same runbook treatment).
- **Compose secrets block: still not adopted** (ADR-0028 — `.env` per level, no Docker `secrets:`).
  Per-app workflow credentials live in encrypted DB rows, which is *better* than env files for this
  use anyway and needs no compose change.

---

## 9. Manual tasks & run status — reuse the ADR-0052 Notification/SSE stack (no new infra)

The "manual step" integration type (a human performs an action / types "which team?") is, from the
ops lens, **just an inbox + a blocking job state** — and lazyit already has the inbox:

- A manual step **pauses the run** (a BullMQ job in a waiting state / a Postgres `WAITING_MANUAL`
  run-state) and **emits an ADR-0052 Notification** to the responsible user(s), delivered to the
  **in-app bell over SSE** (the fetch-based Bearer SSE client decided 2026-06-07 in the decision
  history). The human completes the task in the UI; that resumes the job.
- **No new realtime infra.** SSE is already the v1 transport (ADR-0052); the bell already exists.
  (Caveat the ADR-0052 note flags: SSE fanout is *process-local*. If/when the worker is a separate
  container from the api that serves SSE, a manual-task notification raised by the worker must
  reach the api process that holds the operator's SSE connection. The clean ops answer is to
  **publish notifications through a lightweight Valkey pub/sub channel** the api subscribes to —
  reusing the *same* Valkey we already added, no new component. Flag this as the cross-process
  fanout that ADR-0052 explicitly deferred to "the pending workers ADR" — this engine is where it
  gets solved.)

---

## 10. Resource limits & host sizing on a small box

- **v1 (co-located worker + Valkey):** +1 container (`valkey`, `mem_limit: 128m`, `cpus: 0.5`).
  Total long-running ceilings rise from ~3.2 GB to ~3.3 GB. **Stays within the 4 GB minimum**, but
  the existing "watch `docker stats`, raise limits if a service is throttled"
  guidance (`docs/05-runbooks/deploy-self-hosted.md` §6) becomes more load-bearing. Update the
  sizing table to **recommend 6 GB** once workflows are actively used.
- **Phase 2 (dedicated worker container):** add a `worker` service (~`mem_limit: 384–512m`,
  `cpus: 1.0`). This is the real budget jump. **Recommend the host move to 6–8 GB / 4 vCPU** at
  this point and document it in the sizing runbook. Concurrency is bounded by **BullMQ worker
  concurrency + a per-step timeout + the queue rate-limiter** so a burst of slow external calls
  can't exhaust the worker's memory or sockets — set conservative defaults (e.g. low concurrency,
  a hard per-step timeout, bounded retries with exponential backoff + jitter, mirroring the
  ADR-0043 #196 retry shape).
- **Disk:** Valkey's AOF/RDB on `valkey_data` is small (job metadata for a small team). The 20 GB
  minimum is unaffected materially; the dominant growth is still Postgres + Meili.

---

## 11. Guardrails (conditions of acceptance, ops lens)

1. **One substrate, not two.** The engine uses the ADR-0053 Valkey/BullMQ; it does not add a
   parallel queue. If Valkey is deferred, v1 uses **pg-boss** as a documented, migration-aware
   stopgap — never both at once.
2. **Valkey is rebuildable, not a system of record** (§4). Run state lives in Postgres; the DR
   inventory and backup runbook are unchanged.
3. **No new public surface.** Valkey, the worker, and bull-board are **internal-only**; only Caddy
   publishes ports (ADR-0026/0028). bull-board is gated behind RBAC (a `workflow:*` permission in
   the ADR-0046 catalog) — workflow management has its **own** permissions, and a service account
   never reaches it open-by-default (**INV-SA-2**).
4. **A failing external call never blocks/rolls back the local grant** (§3.5) — the engine
   deliberately does **not** copy ADR-0043/INV-5 strong coupling for *external* provisioning.
5. **Secrets via encrypted `SystemSecret`, never in env/payload/logs** (§8; INV-6, ADR-0031).
6. **Egress is deny-by-default + worker-isolatable** (§7) — app-layer SSRF guard mandatory;
   network-segmented worker the strong form. **Security lane owns the policy.**
7. **WHO executes is an auditable principal.** A workflow run is attributed via the existing
   actor model: a **system/Service-Account principal** ([[0048-service-accounts|ADR-0048]],
   `serviceAccountId` actor columns + the at-most-one-actor CHECK, INV-SA-1..4). A run that revokes
   a grant writes `revokedBySaId`, not a fabricated human — the audit trail stays honest. (The
   engine's worker likely authenticates as a lazyit-native SA, fail-closed, exactly as ADR-0048
   intends a non-human principal to.)

---

## 12. Phased, v1-first plan (DevOps deliverables)

**Phase 0 — land the substrate once (prereq, owned by the ADR-0053 implementation).**
Wire the `valkey` service into `compose.yaml` (unprofiled + prod) + `compose.override.yaml`
(loopback dev port) per §3.1, add `REDIS_URL` to both `.env.example` files (ADR-0028), and update
`docs/05-runbooks/deploy-self-hosted.md` §6 sizing (recommend 6 GB once queues are used) and
`docs/05-runbooks/backups.md` (Valkey = rebuildable, like Meili). The docx-import pilot proves the
pipeline; the engine then *reuses* this — it does not add Valkey again.

**Phase 1 — engine v1 (co-located worker).**
- Co-located BullMQ worker in `api` (§6). Two triggers (grant/revoke) enqueued from
  `access-grants.service.ts`. Integration types: **REST/HTTP, outbound webhook, and MANUAL** first
  (manual reuses the ADR-0052 bell/SSE inbox, §9). Per-app secrets via encrypted `SystemSecret`
  (§8). **App-layer SSRF guard** (§7.1) is a v1 gate, not a follow-up.
- Observability: bull-board internal-only behind RBAC (§5); Pino correlation-id logging (ADR-0031);
  run-complete/failed notification via SSE.
- New `workflow:*` permissions in the ADR-0046 catalog; runs attributed to a Service-Account
  principal (ADR-0048).

**Phase 2 — isolation + timers.**
- Split into a **dedicated `worker` container** for egress isolation + resource isolation (§6),
  on a separable network (§7.2). Recommend the host bump to 6–8 GB and document it.
- **Timer / scheduled triggers** via BullMQ delayed+repeatable jobs (N-days-after-grant,
  re-certification) — and fold in the long-deferred **grant auto-expiry** scheduler
  (ADR-0023/0053). Cross-process notification fanout via Valkey pub/sub (§9 caveat).

**Phase 3 — breadth (mostly app-layer, little new infra).**
- Prebuilt connectors, SDK and **MCP-server** integration types. Most are new *egress targets* +
  allow-list entries, not new containers. **Flag:** an MCP *server* the engine must host would be a
  *new container* — assess against the load-bearing test when it's specced; a co-located MCP
  sidecar is acceptable only if it follows every §1 convention.

---

## 13. Scope-creep flags (ops lens)

- **Identity-governance drift.** The manual "which team? / manager / boss / Active Directory"
  mapping edges toward an HR/Identity-Governance system, which
  [[product-vision-tech|"what lazyit is NOT"]] calls out ("Not an HR system"). *Infra-wise* an
  AD/LDAP sync is "just another egress target" (no new container) — so it does not change this
  substrate decision — but the **feature scope** should stay **Access-pillar provisioning**, and
  the identity-field expansion (role/team/manager) must not become an onboarding product. Raise to
  the CEO; this doc does not design those fields.
- **A second product (n8n/Temporal) creeping back in** under "but it's more powerful." The
  governance + footprint reasons in §3.3/§3.4 are the standing rebuttal.
- **bull-board exposed publicly** "for convenience." Never — internal + RBAC only (§11.3).

---

## 14. Answer to the CEO's substrate question

**Is BullMQ + Redis/Valkey right, overkill, or is something simpler enough?**

From the DevOps/operability chair: **BullMQ + Valkey is the right substrate — and it is *not*
overkill, because the org already committed to it in [[0053-async-workers-bullmq-valkey|ADR-0053]]
and the workflow engine is one of the two features that justified it.** It costs **one extra
container** that drops cleanly into the existing single-file `docker compose up`, follows every
operability convention, and — with the §4 "Valkey is rebuildable" guardrail — **adds zero new
backup burden** for the IT-generalist operator.

- **Temporal is overkill and a profile violation** (+3 containers, a third datastore, a third DR
  item, a steep concept curve on a 4 GB host) — reject for self-hosted.
- **n8n is the wrong shape** — a second product that forks our audit/RBAC/secrets governance —
  reject as the substrate (fine as an integration *target*).
- **Synchronous is right only for the no-workflow default path** (keep it), and wrong for external
  provisioning calls (don't copy ADR-0043's strong coupling).
- **pg-boss is the honest "simpler enough" option and the literal load-bearing-test winner**
  (zero new infra, jobs already backed up). It is the **correct v1 choice *only if* the CEO wants
  to defer Valkey** — accepting that timer triggers + true flows later re-open the Valkey question
  exactly as ADR-0053 predicted.

**Recommendation:** proceed on **Valkey/BullMQ per ADR-0053**, co-located worker for v1, dedicated
egress-isolated worker by Phase 2, the seven §11 guardrails as conditions of acceptance, and the
host-sizing + backup-runbook updates in Phase 0. This keeps the engine powerful enough for real
multi-step provisioning while keeping the operator's world at *one command, one extra small
container, two `pg_dump`s, one masterkey.*

---

Related: [[0053-async-workers-bullmq-valkey]] · [[0023-access-management-design]] ·
[[0043-zitadel-source-of-truth]] · [[0028-secrets-and-config]] · [[0025-containerization-strategy]] ·
[[0026-reverse-proxy-tls]] · [[0031-logging-strategy]] · [[0009-bun-first-vs-app-stack]] ·
[[0046-roles-permissions-v2]] · [[0048-service-accounts]] · `docs/06-security/INVARIANTS.md` ·
`docs/05-runbooks/deploy-self-hosted.md` · `docs/05-runbooks/backups.md` ·
`compose.yaml` · `compose.override.yaml` · `infra/docker-compose.prod.yaml` ·
`apps/api/src/access-grants/access-grants.service.ts`
</content>
</invoke>
