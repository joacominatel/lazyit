---
title: "Applications Workflow Engine — Orchestration & Execution Substrate"
tags: [workflow-engine, orchestration, queue, bullmq, valkey, async, design, access]
status: proposed
created: 2026-06-07
area: orchestration
relates: [0053-async-workers-bullmq-valkey, 0052-settings-notifications, 0048-service-accounts, 0046-roles-permissions-v2, 0043-zitadel-source-of-truth, 0023-access-management-design, 0007-flexible-asset-specs-jsonb, 0006-soft-delete-and-auditing, 0009-bun-first-vs-app-stack]
---

# Applications Workflow Engine — Orchestration & Execution Substrate

> **Scope of this document.** This is the *orchestration / execution-substrate* design for the
> Applications Workflow Engine. It answers the decisive question the CEO posed — **what runs the
> workflows** — and nothing more. Data-model depth (the exact columns of `WorkflowDefinition` /
> `WorkflowRun`), integration-adapter shapes, the configuration UI, and per-app secret handling are
> sibling concerns owned by other area docs; this doc specifies them only to the depth needed to
> justify the substrate choice. The product framing (opt-in per application; **no workflow
> configured → access behaves exactly as today**, [[0023-access-management-design]]) is assumed.

---

## 1. The question, answered up front

**Recommendation: the Applications Workflow Engine SHARES the substrate that
[[0053-async-workers-bullmq-valkey]] is already bringing in — BullMQ on a self-hosted Valkey — and
puts the *durable run state, the pause points, and versioning in PostgreSQL*, using BullMQ only as an
at-least-once step executor.**

In one line: **BullMQ executes steps; PostgreSQL remembers everything.** That split is the whole
design, and it is why we need neither a heavier durable-execution engine (Temporal) nor a separate
workflow product (n8n).

This is the right call for three concrete reasons:

1. **The infrastructure cost is already paid.** ADR-0053 is *accepted* and adds Valkey to
   `compose.yaml` regardless — its stated justifications are the `.docx` import bomb (SEC-002),
   grant auto-expiry, **and this very engine** ("the Applications workflow engine — multi-step flows
   with parent/child dependencies"). The marginal infra the engine adds on top of ADR-0053 is
   **zero new containers**: a couple of new queues and a few new tables. Choosing anything else
   either contradicts an accepted ADR or runs *two* job systems on one host — strictly worse for the
   operator.
2. **The hard requirement — human-in-the-loop pauses that wait hours or days — is NOT a broker
   problem.** It is a *state* problem. We solve it by transitioning the run to `AWAITING_INPUT` in
   Postgres and **completing** the BullMQ job (freeing the worker), then nudging a human through the
   [[0052-settings-notifications|ADR-0052]] notification/bell/SSE stack. The wait costs nothing —
   no held worker, no broker resource, survives any restart. When the human submits, a *new* resume
   job is enqueued. This is the standard process-manager/saga-over-a-queue pattern and it removes
   the single biggest reason people reach for Temporal.
3. **The load-bearing operator constraint survives.** One `docker compose up`, an IT generalist
   operator, no mandatory cloud, fully functional offline except for the external apps it calls
   ([[product-vision-tech]], [[0015-deployment-model]]). BullMQ+Valkey is one boring extra container
   that ADR-0053 already accepted; Temporal is a multi-service platform; n8n is a second full
   product. Only BullMQ keeps the promise.

**The honest caveat (read §6.3):** if ADR-0053 were *reverted*, the correct standalone answer would
be **pg-boss on the existing Postgres** (zero new infra), not BullMQ — our flows are shallow and our
durability already lives in Postgres. BullMQ wins **because Valkey is already arriving**, not because
the engine intrinsically demands a Redis-class broker.

---

## 2. What the engine actually has to do (requirements, from this lens)

The triggers begin with two, both of which originate at concrete code we already own
(`apps/api/src/access-grants/access-grants.service.ts`):

- **access granted** → `AccessGrantsService.create()` (and the multi-row `batchRevoke`'s inverse).
- **access revoked** → `AccessGrantsService.revoke()` / `batchRevoke()`.
- **(later) time/timer/scheduled** → re-certification, "N days after grant", periodic sweeps.

Against those triggers the substrate must support:

| # | Requirement | Why it bites |
| --- | --- | --- |
| R1 | **Durable runs** — a run survives an API/worker restart | A provisioning run that vanishes on a redeploy is unacceptable for an audit-by-default product. |
| R2 | **Human-in-the-loop pauses, hours→days** | The "which team?" manual step; an app with no API where a human acts. The run must idle cheaply. |
| R3 | **Timers / delays / scheduled re-certification** | Phase 3 triggers; also grant auto-expiry (an ADR-0053 sibling). |
| R4 | **Retries + idempotency** | External APIs are flaky; a retried "create Jira user" must not create two. |
| R5 | **Multi-step flows with ordering / dependency** | "create user" → "add to team" → "notify". Some steps gate on a prior step's output. |
| R6 | **Per-app rate limiting** | Don't trip Jira/Okta API quotas when a batch onboarding fires many runs at once. |
| R7 | **Versioning + replay + observability** | A definition edited mid-flight must not corrupt in-flight runs; failed runs must be inspectable and re-runnable. |
| R8 | **Decoupling from the local write** | A failing external call must **NOT** roll back or block the local `AccessGrant` (see §3 — the ADR-0043 contrast). |
| R9 | **Operator cost ≈ zero new infra; offline-capable** | The load-bearing constraint. |

R8 and R9 are the constraints that eliminate options; R2 and R7 are the ones people *think* eliminate
BullMQ (they don't — we move them into Postgres).

---

## 3. The architectural keystone: decouple, do NOT copy the Zitadel strong-coupling

lazyit already has **one** synchronous external-system mirror, and it is deliberately strongly
coupled: the Zitadel write-back ([[0043-zitadel-source-of-truth]], [[INVARIANTS]] INV-5). There, a
Management-API failure **rolls the local change back and surfaces 503** — no split-brain — because a
"soft-deleted locally / still-active in the IdP" divergence is a genuine *security* drift
(`apps/api/src/auth/identity/zitadel-management.service.ts`, `apps/api/src/users/users.service.ts`).

**The workflow engine must do the OPPOSITE.** This is the most important rule in this document:

> **INVARIANT (engine).** The local `AccessGrant` write is the source of truth and commits
> independently of any external provisioning. The engine is triggered **after** the grant commits,
> never inside the grant transaction. A failing, slow, or paused external call **never** rolls back,
> blocks, or 503s the `AccessGrant`.

Why the inversion is correct: an *un-provisioned* Jira account is a **recoverable operational
state** — it shows up as a failed/retrying run in the inbox and gets fixed — whereas the Zitadel case
is a *security* state. Coupling provisioning to the grant would (a) make granting access as slow and
fragile as the worst external API, (b) make human-in-the-loop literally impossible (you cannot hold
a `POST /access-grants` request open for two days), and (c) reproduce exactly the strong-coupling the
brief tells us to avoid here.

### 3.1 Trigger delivery — transactional outbox (recommended) vs post-commit enqueue

To honour "trigger only after commit, but never miss a trigger," two options:

- **(A) Transactional outbox _(recommended for v1)_.** In the *same* `$transaction` as the
  `AccessGrant` create/revoke, insert a small `WorkflowTrigger` (outbox) row. A relay — itself a
  BullMQ repeatable job — drains new outbox rows and enqueues the first step. Guarantees **exactly
  one run per matching grant event** even if the API crashes in the gap between the grant commit and
  the enqueue. Matches lazyit's auditability-by-default ethos; the cost is one table + one drain
  job (we have the broker anyway). **Requires a small, surgical change to `AccessGrantsService`** —
  flag this as a backend contract (see §9 dependencies).
- **(B) Post-commit enqueue _(simpler fallback)_.** Enqueue from a post-commit hook after the
  `$transaction` resolves. No new table, but a process crash in the sub-second window drops the
  trigger (grant exists, no run). Tolerable only with a periodic **reconciliation sweep** (a
  repeatable job that finds matching grants with no run and back-fills).

I recommend **(A)**. It is cheap, it is the senior call, and "every state change is reconstructable"
is already how this codebase thinks ([[0006-soft-delete-and-auditing]], [[0044-recent-activity-view]]).

---

## 4. The recommended architecture (substrate view)

```
 POST /access-grants ──► AccessGrant row committed ──► WorkflowTrigger (outbox, same tx)
                                                              │
                              ┌───────────────────────────────┘  (relay: BullMQ repeatable job)
                              ▼
                    WorkflowRun (PENDING, Postgres) ──enqueue──► BullMQ queue: workflow-steps
                              │                                          │
                              │                              one job = ONE step attempt
                              ▼                                          ▼
              ┌─────────────────────────────────┐        run step via Integration Adapter
              │ Postgres = durable brain         │        (REST | webhook | SDK | MCP | manual)
              │  WorkflowDefinition (versioned)  │◄───────── record WorkflowStepRun (append-only)
              │  WorkflowRun (lifecycle)         │
              │  WorkflowStepRun (append-only)   │── AWAITING_INPUT? ─► Notification (ADR-0052
              └─────────────────────────────────┘                       bell + SSE), job COMPLETES
                              ▲                                          │
                              └──── resume job (on human submit) ◄───────┘
```

**Division of responsibility:**

- **PostgreSQL owns durability, state, pause, versioning, audit.** Three new domain tables:
  - `WorkflowDefinition` — opt-in, per-`Application` + per-trigger, configuration as **jsonb
    validated by zod** (the accepted [[0007-flexible-asset-specs-jsonb]] pattern). Editable;
    soft-deletable; **versioned**.
  - `WorkflowRun` — the lifecycle state machine: `PENDING → RUNNING → AWAITING_INPUT →
    SUCCEEDED | FAILED | CANCELLED`. It **snapshots the definition version it started under**, so an
    admin editing a definition never corrupts in-flight runs (R7 versioning, for free, in Postgres).
  - `WorkflowStepRun` — **append-only** per step attempt (input, output, error, adapter, attempt #,
    timing). This *is* the replay/observability story (R7) and the audit trail (governance) — same
    append-only discipline as [[asset-history]] / [[access-grant]] ([[0006-soft-delete-and-auditing]]).
- **BullMQ owns execution only.** One job = one step attempt. The job: loads the run, runs the step's
  adapter, writes a `WorkflowStepRun`, then either advances the run (enqueue next step), transitions
  it to `AWAITING_INPUT` and **returns** (so the worker is freed for the duration of the human wait),
  or fails it. BullMQ gives us R4 (retries+backoff), R3 (delayed/repeatable jobs), R6 (per-queue rate
  limiting), and R5 (ordering — though our flows are shallow enough that "enqueue next on completion"
  suffices; BullMQ *Flows* are available if a branchy DAG ever appears).
- **Valkey is never the source of truth.** ADR-0053 enables AOF (`appendonly yes`) so queued jobs
  survive a restart, but even a last-fsync AOF gap only loses an *enqueue* — the `WorkflowRun` still
  sits in `PENDING`/`RUNNING` in Postgres and is recovered by BullMQ's stalled-job reclaim or the
  reconciliation sweep. **Losing Valkey loses throughput, never state.**

### 4.1 Human-in-the-loop, concretely (R2)

A `MANUAL` step does **not** keep a job or a worker alive. The step:
1. writes a `WorkflowStepRun` of kind `manual`, sets the run to `AWAITING_INPUT`,
2. fires a [[0052-settings-notifications|Notification]] (in-app bell + SSE realtime; optional
   fail-soft email) to the assignee/role, carrying the task and any **suggested values**,
3. **returns successfully** — the BullMQ job is done; nothing is held.

The wait can be minutes or a week; it costs one Postgres row. On submit (a new
`POST /workflow-runs/:id/steps/:stepId/submit`-style endpoint), we enqueue a **resume job** that
feeds the human's input into downstream data-mapping and continues. This is the cleanest possible fit
between the workflow engine and the ADR-0052 stack the brief tells us to reuse.

> **Scope flag (Identity-Governance creep).** Manual steps must stay a **generic typed input form
> with optional suggestions** (e.g. "which team?" with role/team hints). We must **not** grow an
> org/role/manager/AD model inside the engine to power those suggestions — that is the FUTURE
> "richer identity fields" work the brief says to document, not design. Keep this Access-pillar
> provisioning; the moment a manual step needs a real manager/AD graph, escalate (it edges into
> Identity Governance, an anti-goal per [[product-vision-tech]] "not an HR system").

### 4.2 Idempotency, retries, and the multi-grant subtlety (R4)

- Every step carries a stable **idempotency key** (`runId:stepId:attempt-family`) so a BullMQ retry
  of "create Jira user" can be deduped where the target supports it; adapters declare whether a step
  is `create-or-noop`.
- **Multi-grant changes the semantics of deprovision.** [[0023-access-management-design]] allows a
  user to hold *several* active grants on one application (no uniqueness constraint). So revoking
  *one* grant must **not** blindly deprovision if the user still holds another active grant on that
  app. The revoke-trigger's deprovision step must guard on "no other active `AccessGrant` remains
  for (user, application)." This is a real design rule and an **open question** for the CEO
  (deprovision on *last* revoke only, vs per-grant) — see §10.

### 4.3 Who executes, and how runs are attributed (governance)

Workflow actions are performed by the engine, not a human clicking. The natural principal is the
[[0048-service-accounts|Service Account]] model (or a dedicated reserved system principal): a
non-human identity with **direct catalog permissions, never a Role, never ADMIN-equivalent,
fail-closed** (INV-SA-2/3). Runs and their external calls are attributed in the append-only trail via
the existing **at-most-one-actor** pattern (`serviceAccountId`, INV-SA-4) — honest, queryable,
DB-enforced. Workflow *management* itself is gated by **new permissions added to the ADR-0046
catalog** (e.g. `workflow:read` / `workflow:manage` / `workflow:run`), resolved DB-first like every
other permission (INV-1/INV-8). Per-app credentials are stored with the **ADR-0052 `SystemSecret`
encryption-at-rest** pattern and never logged (INV-6, [[0031-logging-strategy]]).

---

## 5. Substrate comparison matrix

Scored against the §2 requirements. ✅ native / strong · ◐ possible with our Postgres-state design ·
⚠ weak / awkward · ❌ wrong fit.

| Requirement | (a) Synchronous in-request | (b) **BullMQ + Valkey** | (c) pg-boss (existing PG) | (d) Temporal | (e) n8n / embeddable product |
| --- | --- | --- | --- | --- | --- |
| R1 Durable runs | ❌ none | ✅ jobs durable; **state in PG** | ✅ jobs+state in PG | ✅ best-in-class | ✅ (in n8n's own store) |
| R2 Human pause hours→days | ❌ impossible | ✅ via PG `AWAITING_INPUT` + ADR-0052 | ✅ same PG pattern | ✅ first-class signals | ◐ "wait for webhook" node |
| R3 Timers / scheduled re-cert | ❌ | ✅ delayed/repeatable jobs | ✅ cron/deferral | ✅ durable timers | ✅ cron trigger |
| R4 Retries + idempotency | ⚠ manual | ✅ backoff; keys ours | ✅ retry; keys ours | ✅ | ✅ |
| R5 Multi-step flows | ⚠ inline only | ✅ chain / Flows | ◐ thin dependency support | ✅ code-as-workflow | ✅ visual graph |
| R6 Per-app rate limiting | ❌ | ✅ native per-queue | ⚠ weak | ◐ via task queues | ◐ per-node |
| R7 Versioning + replay + observ. | ❌ | ◐ **PG snapshot + StepRun**; bull-board | ◐ PG snapshot; thinner tooling | ✅ replay is the headline | ✅ visual runs/replay |
| R8 Decoupled from local write | ❌ couples (the wrong INV-5) | ✅ post-commit outbox | ✅ post-commit outbox | ✅ | ✅ (separate system) |
| **R9 Operator cost / offline** | ✅ zero infra | ✅ **0 extra over ADR-0053** | ✅✅ **truly 0 new infra** | ❌ multi-service platform + own datastore + UI | ❌ second full product + its DB/auth/UI |
| Reuses our secrets/notif/RBAC/audit | n/a | ✅ SystemSecret + ADR-0052 + ADR-0046 + append-only | ✅ same | ⚠ partial (own runtime) | ❌ **fractures** all four |
| Fits ADR-0009 (Node app layer) | ✅ | ✅ (`@nestjs/bullmq`, app-layer ioredis) | ✅ | ⚠ separate determinism runtime | ❌ external |
| Consistency w/ accepted ADR-0053 | n/a | ✅ **shares it** | ❌ contradicts (ADR-0053 rejected pg-boss for *this*) | ❌ | ❌ |

**Reading the matrix:** (a) fails R1/R2/R8 outright — it is not an engine, it is the *absence* of
one. (d) and (e) win on raw capability but lose decisively on R9 and on reusing our stack — they are
platforms/products, not libraries, and they fracture the very secrets/notification/RBAC/audit
substrate the brief mandates reusing. (b) and (c) are functionally equivalent *for our shallow
flows* because we keep state in Postgres either way; (b) wins only because **Valkey is already
arriving via ADR-0053** and it does R6 natively, while (c) would mean a second job system or
reverting ADR-0053.

---

## 6. Option write-ups (the honest version)

### 6.1 (a) Synchronous in-request — rejected as the engine, kept as the *non-engine* default
A provisioning call inside `POST /access-grants` reproduces the Zitadel strong-coupling (INV-5) in
the one place we were told not to (R8), and it cannot pause for a human (R2). **Reject.** But note:
the product default — *no workflow configured → record the `AccessGrant` exactly as today* — IS the
synchronous, no-queue path. That is not "option (a) as a substrate"; it is the engine simply not
firing. Keep it.

### 6.2 (b) BullMQ + Valkey — **recommended**
Durable jobs, backoff retries, delayed/repeatable jobs (R3), per-queue rate limiting (R6), a mature
first-class `@nestjs/bullmq` integration, sandboxed processors for any adapter that runs untrusted or
heavy code (the [[0053-async-workers-bullmq-valkey|ADR-0053]] SEC-002 mechanism), and bull-board for
queue observability. Its only true gaps versus Temporal — long human waits (R2) and versioning/replay
(R7) — we close in Postgres (`AWAITING_INPUT` + definition snapshot + append-only `WorkflowStepRun`).
**Marginal infra over ADR-0053 = zero.** This is the recommendation.

### 6.3 (c) pg-boss on existing Postgres — the *counterfactual* winner; recommended fallback
If ADR-0053 did **not** exist, pg-boss would be my pick: **truly zero new infra**, cron + deferral +
job singletons, reuses Postgres backups, and our flows are shallow with durability already in
Postgres — so pg-boss's thinner flow/dependency support barely matters. The reasons it loses *today*
are specific and not about raw capability:
1. **ADR-0053 already evaluated and rejected pg-boss as the primary**, precisely citing the workflow
   engine's needs, and warned it "would have to be replaced exactly when the workflow engine lands."
   Choosing it now contradicts an accepted decision.
2. **Valkey is arriving anyway** (docx/SEC-002, expiry, backups). Picking pg-boss means **two job
   systems on one host** — strictly worse for the operator (R9) than one.
3. **Per-app rate limiting (R6)** is a genuine workflow need (don't hammer Jira's quota on a batch
   onboarding); BullMQ does it natively, pg-boss does it poorly.

**Recommend pg-boss only if ADR-0053 is reversed.** If lazyit ever decided Valkey is not worth a
container, the engine would be fine on pg-boss with the same Postgres-state design — that portability
is a feature of putting state in Postgres, not the broker.

### 6.4 (d) Temporal — rejected for v1 (operator cost), kept as a far-future escape hatch
Temporal is *the* right tool for durable provisioning workflows with long sleeps and human signals —
on capability it tops the matrix. It loses on the **load-bearing constraint**: Temporal Server is a
multi-service platform (frontend/history/matching/worker) **plus its own datastore** (Cassandra or a
dedicated Postgres) **plus optional Elasticsearch plus a Web UI**. The single-binary dev mode is not
production-grade. That violates "one `docker compose up`, IT-generalist operator, boring durable
technology" ([[0015-deployment-model]], [[product-vision-tech]]) and sits outside the NestJS+Prisma
app model ([[0009-bun-first-vs-app-stack]]) with its own determinism programming model. **Reject for
v1.** Cheap insurance: because our domain model (`WorkflowRun`/`WorkflowStepRun`) is independent of
the executor, a future migration to Temporal would swap the *executor* without rewriting the domain —
but that is a "not on the horizon" scenario for a 5–200-person tool.

### 6.5 (e) n8n / embeddable workflow product — rejected as the engine; allowed as ONE adapter
n8n's connector library is tempting for integration breadth. But it is a **separate product**, not a
library: self-hosting it adds a second full app with **its own DB, its own auth/RBAC, its own UI, and
its own credential store** — which **fractures the four things the brief says to reuse**: per-app
secrets would live in n8n (not our encrypted `SystemSecret` + redacted audit), governance/RBAC would
live in n8n (not the ADR-0046 catalog), the audit trail would live in n8n (not our append-only
tables), and the operator would run and learn a second complex product (R9). Its "fair-code"
Sustainable-Use license also rubs against the "open-source by default, ships for everyone"
([[product-vision-tech]]) stance. **Reject as the substrate.** *However*, "call an **n8n webhook**"
is a perfectly good **integration adapter type** for the long tail (Phase 4) — a power user who
already runs n8n can offload exotic connectors to it. That is an adapter behind our engine, not the
engine itself.

---

## 7. Phased, v1-first plan

**Phase 0 — substrate landing (prerequisite, NOT this engine's work).** Valkey in `compose.yaml`
(unprofiled + prod profile, AOF on), `@nestjs/bullmq` + ioredis (app-layer, ADR-0009), the base queue
module — all delivered by [[0053-async-workers-bullmq-valkey]] (issue #247, currently in-flight on
`feat/issue-247-async-workers-bullmq-valkey`; **not yet in code/compose** as of 2026-06-07). **The
engine MUST NOT introduce a second broker.** Gate: ADR-0053 implementation merged.

**Phase 1 — the spine (one trigger pair, one integration type).**
- Tables: `WorkflowDefinition` (jsonb+zod, per-app+trigger, versioned), `WorkflowRun` (lifecycle +
  definition snapshot), `WorkflowStepRun` (append-only).
- Triggers: **access-granted** + **access-revoked**, via the §3.1 **transactional outbox** wired into
  `AccessGrantsService.create/revoke/batchRevoke`.
- Executor: one queue `workflow-steps`; one job = one step; in-process `@Processor` is fine for light
  I/O (sandboxed processor reserved for untrusted/heavy adapters, ADR-0053).
- One adapter: **outbound REST/HTTP** (the Jira example). Per-app credential via ADR-0052
  `SystemSecret`. Data mapping = declarative jsonb templating (`user.email`, `user.firstName`,
  `application.name`, …) validated by zod.
- Decoupling enforced (§3); retries+idempotency (§4.2); runs attributed to a service-account
  principal (§4.3); new `workflow:*` permissions in the ADR-0046 catalog; bull-board for ops.
- **Out of Phase 1:** manual steps, timers, webhooks, SDK/MCP, prebuilt connectors.

**Phase 2 — human-in-the-loop + the manual-task inbox.** The `MANUAL` step (§4.1): `AWAITING_INPUT`
+ ADR-0052 notification/bell/SSE + a resume endpoint/queue. Generic typed input + optional
role/team suggestions (keep the Identity-Governance scope flag, §4.1).

**Phase 3 — timers + scheduled triggers + re-certification.** BullMQ delayed jobs ("N days after
grant") + repeatable jobs (periodic re-certification sweep). Shares the substrate with **grant
auto-expiry** — an ADR-0053 follow-up — which validates the shared-substrate thesis.

**Phase 4 — integration breadth (pluggable adapters).** One adapter interface, many typed configs
(jsonb+zod, ADR-0007): inbound/outbound webhooks, vendor SDK (in-process module), MCP client, **"call
an n8n webhook"** (the §6.5 long-tail escape), prebuilt connectors for famous apps, self-hosted
targets, "build the API ourselves" (= a REST/webhook adapter pointed inward). Untrusted/heavy
adapters run in **sandboxed processors** (ADR-0053).

**Phase 5 — versioning depth, replay, reporting.** "Re-run a failed run from step N against its
frozen definition"; reporting views over `WorkflowRun`/`WorkflowStepRun` (failure rates, pending
manual tasks, runs-per-app), possibly a Postgres view in the [[0044-recent-activity-view]] style.

---

## 8. Relationship to ADR-0053 (explicit)

**They share the substrate — by ADR-0053's own design.** ADR-0053 names this engine as one of the
two features that *justify* a durable broker ("multi-step flows with parent/child dependencies"), and
it explicitly **rejected pg-boss as primary** because pg-boss "would have to be replaced exactly when
the workflow engine lands." So the engine is not a new substrate decision; it is the **payoff** of
ADR-0053. Shared, reused, and added:

- **Shared:** Valkey (one container, AOF persistence), `@nestjs/bullmq` + ioredis (app-layer,
  ADR-0009), the base queue module, sandboxed-processor mechanism, bull-board observability, the
  co-located-worker topology (split to a dedicated worker container is the *same* documented
  follow-up ADR-0053 already lists — load-driven, not engine-specific).
- **Reused from ADR-0052** (currently on `feat/settings_notifications_smtp`, not yet on `dev`): the
  `SystemSecret` encryption-at-rest pattern for per-app credentials, and the Notification + in-app
  bell + SSE realtime + fail-soft email stack for the manual-task inbox and run-status.
- **Added by the engine (no new infra):** queues `workflow-steps` and `workflow-resume`; tables
  `WorkflowDefinition` / `WorkflowRun` / `WorkflowStepRun` (+ the `WorkflowTrigger` outbox);
  `workflow:*` permissions in the ADR-0046 catalog; the surgical outbox write in `AccessGrantsService`.
- **One nuance vs the docx pilot:** the docx job *must* be sandboxed (untrusted, memory-bomb-prone);
  most workflow steps are *light I/O* and run fine in-process — only adapters that execute untrusted
  or heavy code (SDK/MCP/custom) need the sandbox. Same toolbox, a per-job knob.

**Dependency:** the engine is **gated on ADR-0053 landing first**. It does not re-open or challenge
ADR-0053; it validates it. The only thing it would *challenge* is any future attempt to solve human
waits or versioning by holding long-lived BullMQ jobs — those belong in Postgres (§4).

---

## 9. Dependencies on other areas

- **Backend / data model:** the three workflow tables + the `WorkflowTrigger` outbox, and the
  **in-transaction outbox write** inside `AccessGrantsService.create/revoke/batchRevoke`
  (`apps/api/src/access-grants/access-grants.service.ts`). This is the one place the engine reaches
  into existing code — keep it surgical (write an outbox row in the same `$transaction`, nothing more).
- **ADR-0053 (substrate):** must land first (Valkey + `@nestjs/bullmq`). Hard prerequisite.
- **ADR-0052 (Settings/Notifications/SystemSecret/SSE):** must be on `dev` before Phase 1 (per-app
  secrets) and Phase 2 (manual-task inbox). Currently on a branch — flag the ordering.
- **ADR-0046 (RBAC v2):** add `workflow:*` to the frozen catalog in `packages/shared`
  (`permission.ts`); golden tests + parity tests will need updating.
- **ADR-0048 (Service Accounts):** decide the executing principal (a reserved system SA vs a new
  dedicated system principal) and the audit attribution column on the new run tables (at-most-one-actor).
- **Integration-adapter area + Config-UI area:** own the adapter shapes and the admin configuration
  surface; this doc only fixes the executor contract they plug into.

---

## 10. Open questions for the CEO

1. **Deprovision semantics under multi-grant.** [[0023-access-management-design]] allows multiple
   active grants per (user, app). On revoking *one*, do we deprovision only when **no other active
   grant remains** (recommended), or per-grant? This changes the revoke-trigger's guard logic (§4.2).
2. **Trigger delivery guarantee.** Approve the **transactional outbox** (exactly-once trigger, one
   small table, surgical change to `AccessGrantsService`) over the simpler post-commit-hook +
   reconciliation sweep? (Recommended: outbox.)
3. **Executing principal.** Reuse a **Service Account** ([[0048-service-accounts]]) as the engine's
   actor, or mint a dedicated reserved **system principal** for engine runs? (Either works; SA reuses
   existing audit plumbing.)
4. **Failure visibility policy.** When a run FAILS, who is notified and how loudly (admin bell only,
   email, a dedicated "provisioning failures" view)? Ties into ADR-0052 and the no-spam anti-goal.
5. **n8n-as-adapter (Phase 4).** Do we want to officially support "call an n8n webhook" as a
   long-tail adapter, or keep all integration first-party? (Recommended: allow it as *one* adapter,
   never the engine.)
6. **Scope guardrail confirmation.** Confirm manual steps stay generic input+suggestions and the
   engine does **not** grow an org/role/manager/AD model (that stays the FUTURE identity work) — this
   is the line between Access-pillar provisioning and Identity Governance.

---

## 11. Risks

- **R8 regression (the big one).** A future contributor "helpfully" makes provisioning synchronous
  inside the grant transaction, re-coupling it (INV-5 in the wrong place). Mitigation: encode the
  §3 invariant as a test + a CLAUDE/ADR note; the grant write and the engine trigger must stay in
  separate transactions.
- **Long-held jobs anti-pattern.** Someone implements R2 by sleeping a BullMQ job for days. Mitigation:
  the `AWAITING_INPUT`-in-Postgres pattern is the *only* sanctioned pause; document it loudly.
- **Two-broker drift.** Someone adds pg-boss "just for workflows." Mitigation: §6.3 / §8 — one broker,
  ADR-0053's, full stop.
- **Secret leakage in step logs.** Adapter inputs/outputs may contain credentials/PII. Mitigation:
  redact `WorkflowStepRun` payloads the way ADR-0052's `SettingAuditLog` redacts, never log bodies
  ([[0031-logging-strategy]], INV-6).
- **Versioning corruption.** Editing a definition mid-run. Mitigation: the run executes against its
  **snapshotted** definition version (§4), never the live row.
- **Ordering risk on dependencies.** The engine depends on ADR-0052 and ADR-0053, both currently on
  branches, not `dev`. Mitigation: gate Phase 1 on both being merged; do not start against moving
  branches.

---

## 12. Bottom line

Use the substrate ADR-0053 is already buying: **BullMQ on Valkey, executing discrete steps, with all
durability, pauses, versioning, and audit living in PostgreSQL.** It satisfies every hard
requirement, adds **zero infrastructure** beyond a decision already accepted, reuses the ADR-0052
secrets/notifications/SSE stack and the ADR-0046/0048 governance plumbing the brief mandates, and —
unlike Temporal or n8n — keeps the one-command, IT-generalist, offline-capable operator promise that
is load-bearing for the whole product. BullMQ is **not** overkill here because the broker is already
arriving for other reasons; the only honest alternative, **pg-boss**, wins *only* in the
counterfactual where ADR-0053 is reverted — and our Postgres-state design keeps that escape hatch
cheap.

---

Related: [[0053-async-workers-bullmq-valkey]] · [[0052-settings-notifications]] ·
[[0048-service-accounts]] · [[0046-roles-permissions-v2]] · [[0043-zitadel-source-of-truth]] ·
[[0023-access-management-design]] · [[0007-flexible-asset-specs-jsonb]] ·
[[0009-bun-first-vs-app-stack]] · [[0031-logging-strategy]] · [[0030-list-pagination-contract]] ·
[[0006-soft-delete-and-auditing]] · [[0015-deployment-model]] · [[INVARIANTS]] ·
[[product-vision-tech]] · `apps/api/src/access-grants/access-grants.service.ts` ·
`apps/api/src/auth/identity/zitadel-management.service.ts` · `apps/api/src/common/actor.service.ts` ·
`compose.yaml`
