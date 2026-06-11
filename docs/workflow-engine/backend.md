---
title: "Applications Workflow Engine — Backend (NestJS engine) design"
tags: [design, workflow-engine, backend, nestjs, async, bullmq, access]
status: proposed
created: 2026-06-07
area: backend
---

# Applications Workflow Engine — Backend (NestJS engine)

> Scope of this document: the **NestJS backend** of the per-application provisioning/deprovisioning
> workflow engine. It covers how a trigger fires, the execution model (per-run state machine, step
> handlers, idempotency, retry, compensation, manual-step pause/resume), how a workflow definition is
> stored and validated, transaction boundaries, the mapping onto the chosen execution substrate, the
> testing strategy, and a phased v1-first plan. It is a design — **no code, schema or migrations are
> written here.** Companion areas (frontend, devops, security, data-model) are separate documents.

---

## 0. TL;DR and the substrate verdict

**The engine is an opt-in, per-[[application]] reaction to access-lifecycle events.** When IT opens or
revokes an [[access-grant]] inside lazyit, the engine — *if and only if* that application has a workflow
configured for that trigger — runs a configurable multi-step flow that provisions/deprovisions the user
in an external system. If no workflow is configured, the grant behaves exactly as today
([[0023-access-management-design]]) — nothing changes.

**Substrate verdict (implementation lens): adopt BullMQ on Valkey, exactly as already accepted in
[[0053-async-workers-bullmq-valkey]] — but treat BullMQ as the *scheduler/transport*, not the source
of truth for run state.** The durable per-run state machine lives in **Postgres** (a `WorkflowRun` +
append-only `WorkflowStepRun` event model); BullMQ/Valkey provides only what Postgres is bad at:
durable job hand-off, retry-with-backoff, **delayed jobs** (future timer triggers + retry scheduling),
**sandboxed processors** (crash/OOM isolation for untrusted connector code, SDKs, MCP servers) and
**per-application rate limiting** of outbound calls. Concretely, ranked:

- **Synchronous execution — rejected.** It re-creates the exact coupling we must avoid: a failing Jira
  call would block or roll back the local grant. That is correct for the Zitadel identity mirror
  ([[0043-zitadel-source-of-truth]] §3, INV-5) and **wrong here** (see §2).
- **pg-boss (Postgres-only, zero new infra) — rejected as the broker, but its instinct is honoured.**
  [[0053-async-workers-bullmq-valkey]] already weighed and rejected it (no first-class flows, weaker
  rate-limiting, thinner NestJS/observability ecosystem) and the project has *already* committed to
  Valkey for the `.docx` bomb (SEC-002), grant auto-expiry, and backups-from-frontend. Because Valkey
  is paid-for anyway, BullMQ is the cheaper marginal choice. The *part* pg-boss got right — "run state
  belongs in Postgres" — we keep: the run/step rows are Postgres, BullMQ only carries jobs.
- **Temporal — rejected, concepts stolen.** Temporal is the *technically ideal* durable-workflow
  engine (deterministic replay, built-in saga compensation, signals = manual-step resume, timers =
  scheduled triggers). But it is a heavy multi-service deployment (server + its own datastore +
  history/matching/worker tiers) and a second programming model — a violation of the single-host,
  `docker compose up`, IT-generalist operator constraint ([[product-vision-tech]] "Target operator
  profile"). We replicate its *ideas* (durable run state, saga rollback, signal-based resume) on the
  substrate we already run.
- **n8n — rejected as the engine, viable as a *target*.** n8n is a separate product with its own
  datastore, auth and audit model; embedding it would put workflow governance *outside* lazyit's RBAC
  ([[0046-roles-permissions-v2]]), audit trail ([[0006-soft-delete-and-auditing]]) and secret store
  ([[0052 / SystemSecret]]). That contradicts the mandate ("governance gated by its OWN RBAC",
  "produces reports/audit trails"). It is, however, a perfectly good *connector target* later — a
  workflow HTTP/webhook step can call an n8n flow.

**Bottom line:** BullMQ + Valkey is right *because the run state machine is ours and lives in Postgres*.
BullMQ is the muscle; Postgres is the memory. We deliberately do **not** model the step graph as a
BullMQ Flow tree (see §4.6).

---

## 1. Scope, non-goals, and the anti-creep boundary

**In scope (v1 lens):**
- Two triggers to start: **access granted** and **access revoked** ([[access-grant]] create / revoke).
- Per-application, opt-in workflow **definitions** with an ordered set of steps.
- A durable **execution engine** that runs a definition when its trigger fires.
- A **handler per integration type** so any external app is reachable.
- **Manual steps** that pause a run for a human and resume it.
- **Audit, reports and run history** built on lazyit's existing append-only conventions.
- **Its own RBAC permissions** extending the catalog ([[0046-roles-permissions-v2]]).

**Explicit non-goals / deferred:**
- **Scheduled / timer / re-certification triggers** — designed-for but built in a later phase (§14).
- **Prebuilt connectors for famous apps** — a later phase; the handler abstraction makes them additive.
- **Bidirectional sync / reading external state back into lazyit** — out of scope (this is *outbound*
  provisioning, not a sync engine).
- **Approval workflow for access requests** — that is [[access-request]] (a different deferred feature,
  [[0023-access-management-design]]); the engine reacts to grants that *already exist*, it does not
  gate their creation.

> [!warning] Anti-creep boundary — this is Access-pillar provisioning, NOT an HR/onboarding system
> The worked Jira example needs "email, first name, last name, organization, team…". Email/first/last
> exist on [[user]]. **Organization, team, manager, boss, Active-Directory attributes do NOT exist in
> the model** and must not be invented here — adding them would drift lazyit toward Identity Governance
> / HR onboarding, an explicit anti-goal ([[product-vision-tech]] "What lazyit is not"). The engine's
> answer is the **manual step**: when a workflow needs a value lazyit does not hold (e.g. "which Jira
> team?"), it pauses and asks a human, who types it. "Suggestions by role/team" are **deferred** and
> flagged here as the exact creep edge — v1 collects typed input, no role/team inference. If the CEO
> later wants first-class identity fields, that is its own ADR, not this engine's job.

---

## 2. The trigger: why it must be ASYNC and DECOUPLED (the load-bearing contrast)

Today the write path is in `apps/api/src/access-grants/access-grants.service.ts`: `create()` commits an
`AccessGrant` row and attributes the actor; `revoke()` sets `revokedAt`. The engine must start *from*
these two moments **without changing their semantics**.

### 2.1 The decoupling rule, contrasted with the Zitadel mirror

[[0043-zitadel-source-of-truth]] §3 / INV-5 deliberately makes the Zitadel user/role mirror
**synchronous and strongly coupled**: a Management-API failure rolls the local change back and returns
503, because a soft-deleted-local / still-active-in-IdP divergence is a *real security drift*. The
identity mirror must never split-brain.

**The workflow engine must do the OPPOSITE, and this is the single most important backend decision.**
The local `AccessGrant` is the **source of truth for intent** ("IT decided this person should have
access to Jira"). The external system (Jira) is a *downstream effect*. Therefore:

- **A failing external provisioning call must NEVER roll back or block the local `AccessGrant`.** If
  Jira is down, IT's decision is still recorded; provisioning catches up later via retry. Blocking the
  grant on Jira availability would make lazyit's own bookkeeping hostage to every external app's uptime.
- The consistency model is **eventual**: grant commits now, provisioning converges later, failures
  surface as a **failed run + a notification**, never as a 5xx on the grant write.

[[0053-async-workers-bullmq-valkey]] already states this in the inverse: it lists the Zitadel mirror as
"synchronous by design… not a queue candidate", and lists the workflow engine as precisely the feature
that *justifies* a durable queue. This design honours that split: **identity mirror = sync/strong;
provisioning workflow = async/eventual.**

> This is also why the engine is the right home for the consistency model that [[0043-zitadel-source-of-truth]]
> issue #196 layer (c) deliberately *deferred* for identity: queue-and-reconcile. We do for external
> *provisioning* what we explicitly chose **not** to do for *identity*.

### 2.2 How the trigger reaches the engine (decoupled, durable)

`AccessGrantsService` must not import the workflow engine — that would invert the dependency and risk a
workflow concern leaking into the grant transaction. Two viable wirings:

1. **In-process domain event after commit (v1, recommended start).** `AccessGrantsService.create()` /
   `revoke()` emit a small, framework-level domain event (`access.granted` / `access.revoked`) carrying
   `{ accessGrantId, userId, applicationId, actorAttribution }` **after** the DB transaction commits.
   The engine subscribes via a listener (`@nestjs/event-emitter`'s `@OnEvent`, or a thin internal
   `DomainEventBus`). The listener decides whether a workflow is configured for that
   `(applicationId, trigger)` and, if so, creates a `WorkflowRun` and enqueues the first job. **Zero
   change to the grant transaction; the grant never waits on or fails because of the engine.**

2. **Transactional outbox (durability hardening, graduate to when needed).** The risk with (1) is a
   crash in the window *after* the grant commits and *before* the run is created/enqueued → a lost
   trigger → someone has access in lazyit but is never provisioned (a real correctness bug). The robust
   fix is a generic **outbox table** written in the *same* transaction as the grant mutation, relayed
   to BullMQ by a repeatable job. To keep `AccessGrantsService` decoupled, it would write through a
   generic `OutboxService`, not the engine.

**Recommendation:** ship **(1) + a reconciliation sweep** in v1, and reserve **(2)** for if the sweep
proves insufficient. The reconciliation sweep is a BullMQ **repeatable job** that periodically scans
recent grants/revocations whose `(applicationId, trigger)` has a configured workflow but no
corresponding `WorkflowRun`, and creates the missing runs. This gives crash-durability **without
touching the grant write path at all** — the strongest possible guarantee that the engine can never
block a grant, plus a backstop against lost in-process events. The grant table itself is the
reconciliation source of truth; the run table is the engine's. (Whether to adopt the heavier outbox is
an **open question for the CEO** — see §15 — because it is the one option that touches the grant tx.)

---

## 3. Module topology (NestJS)

Two new modules, plus minimal touch-points on existing ones. The split mirrors the project's existing
"contract module vs runtime adapter" separation (e.g. how `auth/identity/` separates the
`IdentityProvider` interface from its Zitadel/generic implementations).

- **`WorkflowsModule`** — the **definition** plane (management API). CRUD for workflow definitions and
  per-application connection/credential config; validation of the step graph against the
  `@lazyit/shared` contracts; the read API for runs/steps (reports). Permission-gated (§11). No queue
  dependency — it only reads/writes Postgres. Controllers here are ordinary REST, paginated per
  [[0030-list-pagination-contract]].
- **`WorkflowEngineModule`** — the **execution** plane (runtime). Owns the BullMQ queue(s), the
  processor(s), the `WorkflowExecutorService` (the state machine), the `StepHandlerRegistry`, the event
  listener that turns `access.granted/revoked` into runs, and the reconciliation/scheduler repeatable
  jobs. Depends on `WorkflowsModule` (to load definitions) and the existing `PrismaService`,
  `SecretEncryptionService`, `NotificationsService`, `ActorService`.
- **Touch-points (additive only):**
  - `AccessGrantsModule` / `access-grants.service.ts` — emit the two domain events after commit. No
    other change; the grant contract is untouched.
  - `CommonModule` — already exports `ActorService` (`apps/api/src/common/actor.service.ts`); reused
    for attributing engine-performed actions.
  - `app.module.ts` — register `BullModule.forRoot` (reads `REDIS_URL`, per
    [[0053-async-workers-bullmq-valkey]]) and the two new modules. Worker is **co-located in the `api`
    container for now** (ADR-0053 topology), with a documented path to a dedicated worker container.

A small **`StepHandler` abstraction** (§4.3) is the engine's analogue of the `IdentityProvider`
interface (`apps/api/src/auth/identity/identity-provider.interface.ts`): one stable interface, many
implementations, selected by a registry keyed on the integration type — and **fail-soft / capability
flagged**, exactly as `IdentityProvider.supportsManagement` lets callers branch on capability.

---

## 4. The execution model

### 4.1 Per-run state machine

Each fire creates one **`WorkflowRun`** that walks a small, explicit state machine. States:

- `PENDING` — run created, not yet picked up (the durable "to-do" the reconciler can also see).
- `RUNNING` — a worker is executing a step.
- `AWAITING_INPUT` — paused on a **manual** step (waiting for a human) or an **inbound-callback** step
  (waiting for an external system to call back). **No BullMQ job is in flight in this state** — this is
  the key reason we do not use a Flow tree (§4.6); a run can wait days for a human without holding a
  worker.
- `RETRY_SCHEDULED` — a step failed transiently; a delayed job is queued to retry.
- `COMPENSATING` — a step failed terminally; the engine is running compensations for already-completed
  steps (saga rollback of *external* effects, never of the local grant).
- `SUCCEEDED` / `FAILED` / `CANCELLED` — terminal.

Transitions are persisted on every change (the run row is the durable cursor). The set is intentionally
small; richer sub-states live on the step events, not the run.

### 4.2 Run and step records (conceptual — Postgres, no schema written here)

- **`WorkflowRun`** (mutable-status header; `cuid` id per [[0005-id-strategy]]): the definition + its
  **pinned version** (§7.3), `applicationId`, `trigger`, the triggering `accessGrantId`, the resolved
  **actor attribution** (triggering human XOR the engine service account, §10), `status`, `currentStepIndex`,
  timestamps, and a redaction-safe `lastError` summary. This is the only row the engine mutates.
- **`WorkflowStepRun`** (**append-only** event ledger, autoincrement id per [[0005-id-strategy]] /
  [[0006-soft-delete-and-auditing]]): one row per step *attempt* — `stepId`, `attempt`, `status`
  (`SUCCEEDED`/`FAILED`/`SKIPPED`/`AWAITING`/`COMPENSATED`), the **idempotency key** used (§4.4), a
  **redacted** request/response summary (INV-6: never the secret, never the raw body —
  [[0031-logging-strategy]]), and timing. This ledger is the audit trail and the report source; it is
  never updated or deleted, only appended.

Storing run state in Postgres (not in BullMQ job data) is deliberate: it survives a Valkey flush, it is
queryable for reports/RBAC, it integrates with the existing soft-delete/append-only model, and it lets
the reconciler and the manual-resume HTTP path operate without consulting the broker.

### 4.3 The `StepHandler` / executor abstraction (one handler per integration type)

The **`WorkflowExecutorService`** is integration-agnostic: it drives the state machine and delegates the
actual external effect to a **`StepHandler`** resolved from a **`StepHandlerRegistry`** keyed on the
step's `integrationType`. Each handler is a NestJS provider implementing a single stable interface
(described in prose; no code here):

- **`type`** — the integration-type literal it serves (registry key).
- **`execute(ctx)`** — perform the step's external effect; return a typed outcome
  (`completed` with output data | `awaiting` with a resume token | `failed` with `{ retryable, reason }`).
  `ctx` carries: the resolved & validated step config, the **decrypted** per-app credentials (§9), the
  mapped input payload (§4.7), the run/step identity, and the **idempotency key**.
- **`compensate(ctx, priorOutput)`** *(optional)* — undo this step's external effect during saga
  rollback (e.g. delete the Jira user the create step made). Absence ⇒ the step is non-compensable
  (recorded as such).
- **`capabilities`** — flags the executor branches on without `instanceof` (e.g. `supportsCompensation`,
  `isManual`, `isAsyncCallback`), mirroring `IdentityProvider.supportsManagement`.

Planned handler implementations (additive over phases — §14):

| `integrationType` | What it does | Isolation | Phase |
| --- | --- | --- | --- |
| `http` (REST API) | Templated outbound HTTP request to the app's API (the Jira case) | in-process (light) | 1 |
| `manual` | Pause for a human; collect typed input via a step-defined zod form schema | n/a (no external call) | 1 |
| `webhook-out` | Fire an outbound webhook (signed) | in-process | 2 |
| `webhook-in` (callback) | Pause; resume when the external system POSTs to a signed callback URL | n/a | 2 |
| `sdk` | Call a vendor SDK | **sandboxed processor** | 3 |
| `mcp` | Call a tool on an MCP server | **sandboxed processor** | 3 |
| `prebuilt:*` | Curated connectors for famous apps | depends | 3+ |
| `selfhosted-http` | Same as `http` but lenient host/scheme rules for internal targets | in-process | 2 |

"We have to build the API ourselves" / "no API at all" collapse onto `manual` (a human does it) or
`webhook-in` (the built thing calls back) — the abstraction already covers them.

### 4.4 Idempotency keys

Every external-effecting step computes a **stable idempotency key** = a hash of
`(workflowRunId, stepId, attempt-invariant inputs)` — *not* the attempt number, so a retry of the *same*
logical step reuses the *same* key. The key is:
- passed to the external system where it supports idempotency (e.g. an `Idempotency-Key` header on the
  `http` handler), so a retried create cannot double-provision;
- recorded on the `WorkflowStepRun`;
- the basis of the engine's own **at-least-once → effectively-once** guard: before executing, the
  executor checks whether a `SUCCEEDED` `WorkflowStepRun` already exists for that key (a duplicate
  delivery / crashed-after-success replay) and short-circuits to "already done".

This matches the precedent in [[0043-zitadel-source-of-truth]] (#196): the two non-idempotent Zitadel
writes are single-shot to avoid duplicates — here we generalise that into an explicit key.

### 4.5 Retry with backoff

Two layers, kept distinct:
- **Transport retry (BullMQ):** transient failures (network, 429, 5xx) use BullMQ's native
  `attempts` + exponential `backoff` with jitter. The handler classifies the failure as `retryable` or
  not; only `retryable` failures consume attempts. Permanent `4xx` (e.g. 400/401/403/422) are **not**
  retried — same policy as the Zitadel client (INV-5 / #196). A `Retry-After` is honoured when present.
- **Business retry (operator) — wired (issue #308):** once attempts are exhausted the run goes `FAILED`;
  an operator with `workflow:run` can **re-run from the failed step** via `POST /workflow-runs/:id/retry`.
  The orchestrator's `retryRun` reads the run's redacted `error.stepKey`, computes the next append-only
  attempt for that step (max + 1), flips `FAILED`→`RUNNING` under a **guarded compare-and-set** (only a
  still-`FAILED` run proceeds — a double-retry / a retry racing the sweeper is idempotent), and
  re-enqueues a delayed-0 `run-retry` job (reusing the colon-free `workflowJobId`) so the walk re-enters
  at the failed step OFF the request thread. Because the walk resumes at that step (not the entry node),
  already-`SUCCEEDED` steps are never re-executed — a non-idempotent create cannot double-provision.
  **Policy: only `FAILED` is retryable** — a `COMPENSATED` run already rolled its external effects back,
  so re-driving it would re-provision what compensation just undid; the endpoint rejects non-`FAILED`
  runs with a 409, and a `FAILED` run with no resolvable failed step with a 422. The grant is never
  touched (the §2 decoupling rule).
- **Retry-after-fix & replay (ADR-0057) — wired (issue #340):** the operator loop *"the flow was wrong, I
  fixed it, now make this stuck run go through"* is first-class, in two complementary `workflow:run` paths:
  - **Option 2 — transient payload override on retry.** `POST /workflow-runs/:id/retry` takes an OPTIONAL
    `overrides` body (a field-name → template/literal map, the shared `RetryRunRequestSchema`). It patches
    the failed step's data mapping for the **next attempt only**: held in an in-memory, single-use map on
    the orchestrator (`pendingOverrides`), merged into the frozen context for ONE render, then discarded.
    **INV-6 hard boundary:** the override never rides the BullMQ job, never touches Postgres / the ledger /
    a log — only the merged field **names** are recorded (exactly as today). A no-body retry is unchanged,
    and the **automatic** per-attempt retry (`retryStep`) never reads the map (it stays deterministic +
    pinned).
  - **Option 3 — clone-to-new-run from the latest version.** `POST /workflow-runs/:id/replay-latest`
    leaves the stuck run **`FAILED` and immutable** and creates a **fresh** run on the workflow's *current*
    version for the same (application, accessGrant, trigger), starting at the entry node and enqueued via
    the normal fire path (`enqueue`) — not a resume. The latest version is resolved by the same
    `planForTrigger` a real grant uses (never re-implemented). A **fail-closed double-provision guard**
    (`assertReplaySafe`) refuses with a **422** when the source run already SUCCEEDED a **non-idempotent**
    create on/before the failed step (re-firing from the entry node would double-provision) — the operator
    re-grants instead (the `COMPENSATED` posture); there is **no warn-and-proceed** path. A non-`FAILED`
    source is a **409**.
  - **Idempotency-key change (localized ADR-0054 §3).** The unique key is now the uniform
    `<trigger>:<accessGrantId>:<replaySeq>`; the organic grant run is `replaySeq = 0` (pre-0057 keys are
    backfilled to `:0` in the migration), each manual replay increments the suffix. A `supersedesRunId`
    self-FK records the parent → clone lineage. A concurrent-replay seq collision (P2002 on the unique key)
    is caught and the seq recomputed/retried — never a 500.

Defaults are conservative (e.g. ≤5 attempts, capped total backoff) and live in step/definition config,
not hard-coded, but with safe ceilings the operator cannot exceed (DoS/foot-gun guard).

### 4.6 Why a DB-driven state machine, NOT a BullMQ Flow tree

BullMQ **Flows** (parent/child) are excellent for fan-out/fan-in of *independent* jobs. A provisioning
workflow is mostly **sequential with data dependencies** (create Jira user → use the returned id → add
to project) and, critically, can **pause indefinitely for a human**. Encoding the whole graph as a Flow
tree is the wrong fit:
- A Flow cannot naturally "wait 3 days for a human" — you would either pin a worker or poll with fragile
  delayed jobs.
- Flow structure is fixed at enqueue time; our graph branches on step outcomes and manual input.
- Run state would live in Redis job trees, not Postgres — losing queryability, RBAC and audit.

**Chosen model — step-at-a-time, re-enqueue:** one BullMQ job = "advance run R". The processor loads the
run, finds the next `PENDING` step, runs its handler, appends the `WorkflowStepRun`, updates the run
cursor transactionally, then:
- next step exists & synchronous ⇒ **enqueue the next "advance" job** (or loop within the same job until
  a boundary, for cheap steps);
- step is `manual`/`webhook-in` ⇒ transition to `AWAITING_INPUT` and **enqueue nothing** (resume is an
  external signal — §4.8);
- step failed retryably ⇒ let BullMQ schedule the retry (`RETRY_SCHEDULED`);
- step failed terminally ⇒ enter `COMPENSATING` (§4.9).

BullMQ Flows remain available as an **opt-in optimisation** for an explicitly parallel fan-out step
group later — not the backbone.

### 4.7 Data mapping (lazyit data → external payload)

A step config declares a **mapping** from lazyit context (the granted `User` profile, the `Application`,
the trigger, prior step outputs, and manual inputs) to the external call's payload. v1 keeps this
**declarative and safe**: a field-map / template with a closed set of resolvable variables (no arbitrary
code execution — that would be a sandbox/RCE surface). Templating is validated at definition time
against the available variable set (zod), so an unresolvable reference is a 400 on save, not a runtime
surprise. Output of a step (e.g. the created Jira user id) is captured into the run context for later
steps to reference. Manual-step inputs enter the same context.

### 4.8 Pause and resume for manual steps (and inbound callbacks)

A `manual` step transitions the run to `AWAITING_INPUT` and creates a **task**:
- It **dispatches a notification** through the existing `NotificationsService` (the ADR-0052 stack on
  `feat/settings_notifications_smtp`: in-app bell + SSE + fail-soft email — `apps/api/src/notifications/`),
  so the assignee sees a manual-task inbox item in real time. **This is the explicit reuse the mandate
  calls for** — we do not build a new realtime channel.
- The task carries the step's **input form schema** (a zod schema in the step config) so the frontend
  renders the right fields.
- Resume is an authenticated, permission-gated **HTTP action** ("complete task" with the typed input).
  The handler validates input against the schema, appends a `WorkflowStepRun` (`SUCCEEDED`, attributed
  to the completing human via `ActorService`), and **enqueues the next "advance" job** — the run leaves
  `AWAITING_INPUT` and continues.

An `webhook-in` step is the same machinery with a **machine** resumer: the engine mints a signed,
single-use callback URL; the external system POSTs back; an HMAC-verified, idempotent callback endpoint
appends the step result and enqueues the advance job. (Same pause/resume primitive, different resumer —
the reason `isAsyncCallback` is a capability flag, not a separate state machine.)

Because the paused run holds **no worker and no in-flight job**, indefinite waits cost nothing — a direct
benefit of the §4.6 model.

### 4.9 Compensation / rollback (saga) for partial failures

When a step fails terminally mid-run, the engine enters `COMPENSATING` and walks the **already-`SUCCEEDED`
steps in reverse**, calling each handler's optional `compensate()` (e.g. the Jira-create step deletes the
user it made). Rules:
- Compensation is **best-effort and idempotent**; each attempt is its own appended `WorkflowStepRun`.
- A non-compensable step (no `compensate()`) is recorded as `COMPENSATION_SKIPPED` — the operator is
  notified so a human can clean up. We never silently pretend an external effect was undone.
- **The local `AccessGrant` is NEVER touched by compensation.** Compensation undoes *external* effects
  only. If a deprovision workflow (revoke trigger) fails, the grant stays revoked locally (intent is
  recorded); the failure surfaces as a `FAILED` run + notification for manual follow-up. This is the §2
  decoupling rule applied to rollback.
- A failed compensation does not loop forever; bounded attempts, then `FAILED` + escalation
  notification.

---

## 5. The fire path, end-to-end (happy + failure)

1. `AccessGrantsService.create()` commits the grant (unchanged), attributes the actor, returns 201.
2. **After commit**, it emits `access.granted`.
3. The engine listener checks: does `applicationId` have an enabled workflow for `granted`? No ⇒ stop
   (today's behaviour). Yes ⇒ create `WorkflowRun(PENDING)` pinned to the definition version, attribute
   the triggering human + engine SA, **enqueue** "advance run R".
4. The processor advances step-by-step (§4.6): `http` create-user → captures the external id →
   `http` add-to-project → `manual` "confirm" (pauses, notifies) → resumes → `SUCCEEDED`.
5. On a transient failure: BullMQ retries with backoff. On a terminal failure: `COMPENSATING` → reverse
   compensations → `FAILED` + notification. **At no point is the grant rolled back.**

---

## 6. Transaction boundaries

The cardinal rule: **never hold a DB transaction open across an external network call.** Concretely:

- **Grant write tx (existing):** untouched. The domain event is emitted *after* commit (§2.2). The
  engine is never inside the grant's transaction.
- **Run creation:** the `WorkflowRun(PENDING)` insert is its own short tx; the BullMQ enqueue happens
  *after* it commits (enqueue-after-commit, so a job never references an uncommitted run). The reconciler
  covers the crash window between insert and enqueue.
- **Per-step execution:** the external call is **outside** any tx. *After* the call returns, a short tx
  appends the `WorkflowStepRun` and updates the run cursor **atomically** (so the durable cursor and the
  ledger never disagree). The next enqueue is after that commit.
- **Manual resume / callback:** validate → one tx (append step + advance cursor) → enqueue.
- **Idempotency guard** (§4.4) closes the "committed step then crashed before enqueue" gap: the replayed
  job sees the `SUCCEEDED` step and skips it.

This is the same discipline the codebase already uses for `$transaction`-wrapped list+count
(`access-grants.service.ts` `findPage`) and the Zitadel offboard-inside-tx (INV-5) — applied to keep
external I/O strictly out of the DB transaction.

---

## 7. Workflow definition: storage and validation

### 7.1 Recommendation: normalized header + jsonb step graph (a hybrid)

There are two poles: a fully **normalized** schema (a `WorkflowStep` table, a `StepTransition` table…)
vs a single **jsonb** `steps` blob validated by zod (the [[0007-flexible-asset-specs-jsonb]] precedent).

**Recommend the hybrid:** a normalized `WorkflowDefinition` **header** (the queryable, FK-bearing,
RBAC- and report-relevant facts — `applicationId`, `trigger`, `name`, `isEnabled`, `version`, timestamps,
soft-delete) **+ a jsonb `steps` graph** validated by a zod schema in `@lazyit/shared`.

Why:
- The header carries everything we **query, index, FK and gate on** (which app, which trigger, enabled?)
  — those must be columns, not buried in json.
- The **step graph is heterogeneous and evolving** — each `integrationType` has a different config shape
  (an `http` step ≠ a `manual` step ≠ an `mcp` step). Modelling that as normalized tables means a schema
  migration every time we add an integration type or a field; jsonb-validated-by-zod is exactly the
  accepted lazyit pattern for "type-specific attributes that vary" ([[0007-flexible-asset-specs-jsonb]],
  used for `Asset.specs`, `Application.metadata`). A **discriminated-union zod schema** keyed on
  `integrationType` gives compile-time + runtime safety without per-type tables.
- It mirrors how the project already treats variable structured config (jsonb + zod), so it is idiomatic
  and low-friction.

The cost (jsonb is less directly queryable, no DB-level FK from a step to, say, a credential) is
acceptable: steps are read as a whole when a run executes, and cross-references are validated by zod at
save time. If a future need to query *across* steps emerges (e.g. "which workflows call host X"), that is
a reporting projection, not a reason to normalize the authoring model.

### 7.2 The contract lives in `@lazyit/shared`

Following [[0009-bun-first-vs-app-stack]] / the shared-package rule and the catalog-as-code precedent in
`packages/shared/src/schemas/permission.ts`:
- A `WorkflowDefinitionSchema` (header + the discriminated-union `StepSchema[]`), `CreateWorkflow…`,
  `UpdateWorkflow…`, and the per-`integrationType` config schemas, all zod-in-shared so `api` (validate,
  execute) and `web` (the builder UI) share **one** definition.
- The set of valid `integrationType` literals is a **closed, frozen catalog** (like the permission
  catalog) so a typo can't mint an integration type and CI fails on an unknown literal.
- Validation runs at the global `ZodValidationPipe` boundary ([[0018]] / `app.module.ts`), so a malformed
  definition is a 400 on save — never a runtime explosion mid-provision.

### 7.3 Versioning — pin a run to a definition snapshot

A run **pins the definition version** it started under (a `version` int on the header, bumped on edit, or
a snapshot of the `steps` json copied onto the run). An in-flight or paused run must finish under the
definition it began with, even if an admin edits the workflow meanwhile — otherwise a manual step could
resume into a graph that no longer matches. This reuses the append-only-snapshot instinct of
`ArticleVersion` ([[0042]]). v1 can store the resolved graph snapshot on the run; a normalized version
table is a later refinement.

---

## 8. Credentials and secrets (reuse, do not reinvent)

Per-app connection auth (Jira API token, OAuth client secret, webhook signing secret, etc.) is **stored
encrypted at rest by reusing the ADR-0052 `SecretEncryptionService`**
(`apps/api/src/settings/secret-encryption.service.ts` on `feat/settings_notifications_smtp`):
AES-256-GCM, versioned envelope, key from `SETTINGS_ENCRYPTION_KEY`. The engine adds **no new crypto** —
it persists per-app credentials as encrypted blobs (the `SystemSecret` pattern) and decrypts them only
inside a `StepHandler.execute`, in memory, just before the call.

Hard rules (from [[INVARIANTS]] INV-6 + [[0031-logging-strategy]]):
- **Secrets are never logged**, never put in a `WorkflowStepRun` request/response summary, never returned
  by the read API (only a redacted descriptor + `tokenPrefix`-style hint, mirroring the service-account
  "shown once" pattern, [[0048-service-accounts]]).
- Connection config validation, audit (a redacted `SettingAuditLog`-style trail), and rotation reuse the
  settings module's existing patterns rather than a parallel mechanism.

This is a **dependency on ADR-0052 landing on `dev`** (it is currently on a branch) — flagged in §13/§15.

---

## 9. Who executes — actor attribution and the run principal

Workflow-performed external actions and the audit rows they generate must be attributed honestly, using
the existing unified principal model (`apps/api/src/auth/principal.ts`, `common/actor.service.ts`,
[[0048-service-accounts]]):

- A run records **both** the **triggering human** (who opened/revoked the grant — already attributed on
  the `AccessGrant` as `grantedById`/`revokedById`) **and** the **engine identity** that performs the
  steps.
- The engine should act as a dedicated **Service Account** ([[0048-service-accounts]]) — the
  "internal/runtime SA" pattern already exists (the Zitadel bootstrap SA). This gives the engine a
  first-class, least-privilege, auditable principal that is **not** a human and **not** ADMIN, and slots
  into the at-most-one-actor CHECK (`serviceAccountId` columns) without faking a `userId`.
- `ActorService.resolveActor(principal)` already returns `{ userId } | { serviceAccountId } | {}` — the
  engine reuses it verbatim so every audit row it writes is CHECK-safe by construction.

> Note: the access-grant *trigger* is attributed to the human who granted; the *provisioning effect* is
> attributed to the engine SA. Both are on the run, so a report can answer "who granted, and what did the
> engine do about it".

---

## 10. RBAC — the engine's own permissions

The engine extends the frozen catalog (`packages/shared/src/schemas/permission.ts`,
[[0046-roles-permissions-v2]]) with a new `workflow` domain. Proposed literals (closed catalog, seeded
ADMIN-only, then configurable per [[0046]] — exact set is a design point to confirm):
- `workflow:read` — view definitions and run history/reports.
- `workflow:write` — create/edit/enable/disable definitions and per-app connection config.
- `workflow:run` — manually trigger / re-run / cancel a run.
- `workflow:task` — complete a **manual step** (who in IT may action the inbox). Possibly distinct from
  `workflow:write` so an operator can action tasks without editing definitions.

Enforcement uses the existing single primitive `@RequirePermission('workflow:…')` +
`PermissionGuard` (`apps/api/src/auth/require-permission.decorator.ts`, `roles.guard.ts`), DB-first
(INV-1/INV-8), seeded via `DEFAULT_ROLE_PERMISSIONS` with a golden test — **no new authz mechanism**.
A **Service Account** can be granted `workflow:*` directly (fail-closed, INV-SA-2) so an external
automation could itself drive workflows later. Credential management (`workflow:write` over secrets)
should sit behind `settings:manage` semantics — secrets are settings-grade sensitive.

---

## 11. Mapping onto BullMQ / Valkey primitives (concrete)

Per [[0053-async-workers-bullmq-valkey]] (`@nestjs/bullmq`, ioredis, `REDIS_URL`, AOF persistence,
co-located worker):

- **Queue `workflow-advance`** — the core "advance run R" jobs. Job data is minimal: `{ workflowRunId }`
  (the run row carries the real state — §4.2). `removeOnComplete` bounded; `removeOnFail` retained for a
  window for diagnostics.
- **Per-job options:** `attempts` + exponential `backoff`+jitter (§4.5); `jobId` set to a dedup key so a
  double-enqueue of the same advance collapses; priority optional.
- **Delayed jobs** — (a) **retry scheduling** (BullMQ-native via backoff), (b) **future timer
  triggers** (e.g. "re-certify 90 days after grant" enqueues a delayed job at grant time — the same
  facility ADR-0053 earmarks for grant auto-expiry).
- **Repeatable jobs** — the **reconciliation sweep** (§2.2) and, later, periodic re-certification scans.
- **Rate limiting** — BullMQ's per-queue limiter (or a per-`applicationId` keyed limiter) throttles
  outbound calls so a burst of grants does not hammer an external API into a 429 storm.
- **Sandboxed processors** — the `sdk`, `mcp`, and any "we built the connector" handler types run in
  **forked child processes with a heap cap** (the SEC-002 isolation mechanism ADR-0053 adopts), so a
  buggy/hostile connector crashes the child, not the API. The `http`/`manual`/`webhook` handlers are
  light and safe enough to run in-process initially.
- **Connection** — a single `BullModule.forRoot` reading `REDIS_URL`; no new env beyond what ADR-0053
  introduces, plus the `SETTINGS_ENCRYPTION_KEY` ADR-0052 already adds.

**What we deliberately do NOT use:** Flows as the backbone (§4.6), and Redis as the store of record
(Postgres is — §0). If Valkey is wiped, runs are recoverable from Postgres (PENDING/AWAITING/RETRY runs
can be re-enqueued by the reconciler) — a durability property a Redis-only model would not have.

---

## 12. Testing strategy (Jest, per [[0012-testing-strategy]])

Core/complex logic gets thorough unit coverage; the engine is "core/complex".

- **Executor state-machine tests** — drive `WorkflowExecutorService` with fake handlers through every
  transition: happy path, retryable vs permanent failure, terminal-failure → compensation, manual pause
  → resume, idempotent replay (a step already `SUCCEEDED` is skipped). No real queue or network.
- **StepHandler unit tests** — each handler with its transport mocked: `http` (templating, idempotency
  header, 4xx-not-retried/5xx-retried classification, redaction), `manual` (form-schema validation,
  notification dispatch), `webhook-in` (HMAC verify, single-use, idempotent). The `IdentityProvider`
  tests (`apps/api/src/auth/identity/identity-provider.spec.ts`) are the template for "interface contract
  tested across implementations".
- **Idempotency / retry** — assert the same logical step computes the same key across attempts and that a
  replay short-circuits; assert backoff/attempt policy.
- **Delayed/timer jobs** — Jest fake timers + a fake/in-memory queue to assert a delayed job is scheduled
  at the right offset (future timer triggers) without real waiting.
- **Queue integration** — a thin **fake queue** (records enqueues) for executor↔queue interaction;
  optionally one real-Valkey integration test behind a flag (like the throwaway-PG verification ADR-0048
  used for the CHECK), not in the default unit run.
- **Definition contract tests** — `bun test` in `@lazyit/shared` for the zod schemas (discriminated union
  per `integrationType`, mapping-variable validation, closed integration-type catalog), mirroring
  `permission.test.ts`.
- **Decoupling / no-rollback tests** — assert that a handler throwing does **not** mutate or roll back the
  `AccessGrant`, and that a grant commit with no configured workflow performs zero engine work.
- **Security tests** — assert no secret/credential appears in any log line, `WorkflowStepRun` summary, or
  read-API response (INV-6); assert SA attribution lands in `serviceAccountId`, never a fake `userId`
  (the per-write-path SA-vs-human spec pattern from [[INVARIANTS]] INV-SA-4).
- **RBAC tests** — `@RequirePermission('workflow:…')` gates (golden parity + per-route 403), reusing the
  existing guard test patterns.

---

## 13. Dependencies on other work

- **[[0053-async-workers-bullmq-valkey]] must land first** — the engine is one of the two features that
  ADR justifies. The engine needs `BullModule`, Valkey in compose, the co-located worker, and the
  sandboxed-processor wiring. **Strict prerequisite.**
- **ADR-0052 (Settings/Notifications/SystemSecret/SSE) must land on `dev`** — currently on
  `feat/settings_notifications_smtp`. The engine reuses `SecretEncryptionService` (per-app creds) and
  `NotificationsService` (manual-task inbox + bell + SSE). **Strict prerequisite for the manual-step and
  credential phases.**
- **[[0048-service-accounts]] (already on `dev`)** — the engine principal + audit attribution.
- **[[0046-roles-permissions-v2]] (already on `dev`)** — extend the catalog with the `workflow` domain.
- **Frontend area** — owns the workflow builder UI, the per-app connection/credential forms, the run
  timeline, and the manual-task inbox UI (consuming the bell/SSE). Contract = the `@lazyit/shared` zod
  schemas this design defines.
- **DevOps area** — Valkey service + AOF + memory ceiling + the (eventual) dedicated worker container;
  the `SETTINGS_ENCRYPTION_KEY` and `REDIS_URL` env in `.env.example`. (Owned by ADR-0053 + the devops
  doc.)
- **Security area** — threat-model the outbound-call surface (SSRF on the `http`/`selfhosted-http`
  handlers — admin-supplied URLs calling internal hosts), webhook callback auth, and credential handling.
  Flagged here, designed there.

---

## 14. Phased, v1-first delivery plan

**Phase 0 — foundations (no behaviour change).** `@lazyit/shared` contracts (definition + step
discriminated union + closed integration-type catalog); the `WorkflowDefinition`/`WorkflowRun`/
`WorkflowStepRun` data model; `WorkflowsModule` + `WorkflowEngineModule` skeletons; the `workflow`
permission domain seeded ADMIN-only; the BullMQ queue wired (ADR-0053). Nothing fires yet.

**Phase 1 — the MVP loop: granted/revoked → `http` + `manual`.**
- Emit `access.granted` / `access.revoked` after commit; the listener creates runs (opt-in per app).
- Handlers: **`http`** (the Jira case) and **`manual`** (pause/resume + notification inbox via ADR-0052).
- The full state machine, idempotency keys, BullMQ retry/backoff, the reconciliation sweep, run/step
  audit ledger, per-app encrypted credentials (ADR-0052 reuse), engine SA attribution, `workflow:*` RBAC,
  paginated run-history read API.
- **Acceptance:** with no workflow configured, grants behave exactly as today; with one configured, a
  Jira user is created on grant and a manual confirm step pauses/resumes; Jira being down never blocks or
  rolls back the grant — it produces a retrying/`FAILED` run + a notification.

**Phase 2 — webhooks, mapping depth, compensation, self-hosted targets.**
- `webhook-out` + `webhook-in` (signed callback resume); richer declarative data-mapping; saga
  `compensate()` on the revoke/deprovision path; `selfhosted-http` with lenient host rules (+ the SSRF
  guard from security).

**Phase 3 — breadth: SDK, MCP, prebuilt connectors, scheduled triggers.**
- `sdk` + `mcp` handlers in **sandboxed processors**; the first `prebuilt:*` connectors; **time/timer
  triggers** (delayed + repeatable jobs) for N-days-after-grant and periodic re-certification. Each is
  additive over the stable `StepHandler` interface — no engine-core rewrite.

**Later / explicitly deferred** — bidirectional sync; identity fields (role/team/manager/AD) *iff* a
separate ADR introduces them (the §1 creep boundary); a dedicated worker container when load warrants
(ADR-0053 follow-up); BullMQ Flows for explicit parallel fan-out groups.

---

## 15. Risks and open questions for the CEO

- **Lost-trigger durability — outbox vs reconciler.** v1 recommends in-process event + reconciliation
  sweep (zero change to the grant tx). The stronger guarantee is a transactional **outbox** written in
  the grant's commit — but that is the one option that *touches the access-grant write path*. **CEO
  decision:** is the reconciler enough for v1, or do we want the outbox (and accept a generic outbox
  table in the grant tx) from the start?
- **Engine principal.** Confirm the engine acts as a dedicated **Service Account** (recommended) vs a
  bare "system" null actor. The SA gives least-privilege + honest audit but is one more managed
  credential.
- **`workflow` permission granularity.** Confirm the `read/write/run/task` split (esp. whether
  completing a manual task is its own permission, and whether credential edits require `settings:manage`).
- **Outbound-call security posture (SSRF).** Admin-supplied URLs can target internal hosts
  ([[0023-access-management-design]] intentionally allows scheme-less internal `url`s). The
  `http`/`selfhosted-http` handlers need an allow/deny policy. **Needs a security ADR before Phase 2.**
- **Identity-field creep.** The manual "which team / manager / AD" need is the boundary toward Identity
  Governance (§1). Confirm v1 stays "typed manual input only", with suggestions/role-team/AD as a future
  separate ADR — not smuggled into this engine.
- **Prerequisite ordering.** Both ADR-0053 and ADR-0052 must be on `dev` before Phase 1; ADR-0052 is
  still on a branch. Confirm sequencing.
- **Run/credential retention.** Run ledgers are append-only and grow; define a retention/archival policy
  (and whether soft-deleting a workflow definition or an application cascades to its runs — likely
  *detach and retain* for audit, mirroring [[0023]]'s SetNull instincts).

---

## 16. Explicit answer to the substrate question

**Is BullMQ + Redis/Valkey right for this engine?** **Yes — adopt it (ratifying
[[0053-async-workers-bullmq-valkey]] from the engine-implementation lens), with the architectural
clarification that BullMQ is the scheduler/transport and Postgres is the source of truth for run
state.** It gives us, on infrastructure we are already adding for unrelated reasons, exactly the
primitives the engine needs (durable async hand-off that *never blocks the grant*, retry+backoff, delayed
jobs for future timer triggers, sandboxed processors for untrusted connectors, per-app rate limiting) —
without the second-product weight of n8n or the multi-service operational burden of Temporal that the
single-host, IT-generalist operator cannot carry. **pg-boss** would also have worked and avoided new
infra, but Valkey is already justified and pg-boss lacks the flow/rate-limit/ecosystem maturity; its one
correct instinct — keep run state in Postgres — we adopt anyway. **Synchronous execution is the one
clearly wrong answer**: it would make lazyit's own access bookkeeping hostage to every external app's
uptime, the precise coupling [[0043-zitadel-source-of-truth]] reserves *only* for identity. The engine
code is simplest and most correct when the **state machine is ours, in Postgres**, and BullMQ is asked to
do only the three things it is genuinely best at: schedule, retry, isolate.

---

Related: [[0023-access-management-design]] · [[0043-zitadel-source-of-truth]] ·
[[0053-async-workers-bullmq-valkey]] · [[0046-roles-permissions-v2]] · [[0048-service-accounts]] ·
[[0007-flexible-asset-specs-jsonb]] · [[0009-bun-first-vs-app-stack]] · [[0031-logging-strategy]] ·
[[0030-list-pagination-contract]] · [[0005-id-strategy]] · [[0006-soft-delete-and-auditing]] ·
[[INVARIANTS]] · [[access-grant]] · [[application]] · [[service-account]] · [[user]]
