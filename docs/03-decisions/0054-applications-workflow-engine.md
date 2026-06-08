---
title: "ADR-0054: Applications Workflow Engine — data model & engine foundations"
tags: [adr, workflow-engine, access, async, security, data-model]
status: accepted
created: 2026-06-08
updated: 2026-06-08
deciders: [Joaquín Minatel]
---

# ADR-0054: Applications Workflow Engine — data model & engine foundations

## Status

accepted — the keystone ADR for **epic #248** (Applications Workflow Engine). Ratifies, from the
engine lens, the substrate of [[0053-async-workers-bullmq-valkey]] ("BullMQ executes, Postgres
remembers") and transcribes the approved architecture synthesis (`docs/workflow-engine/_synthesis.md`,
the binding reconciliation of the seven area designs). Extends the frozen permission catalog
([[0046-roles-permissions-v2]] — the `workflow:*` verbs shipped in Phase 0.3), reuses the
service-account principal + at-most-one-actor pattern ([[0048-service-accounts]]), the flexible
zod-validated jsonb pattern ([[0007-flexible-asset-specs-jsonb]]), the soft-delete / append-only
discipline ([[0006-soft-delete-and-auditing]] / [[0041-soft-delete-reuse-and-restore]]) and the
id strategy ([[0005-id-strategy]]). It is the deliberate **inverse** of the Zitadel strong-coupling
([[0043-zitadel-source-of-truth]] / INV-5).

> **Scope of this ADR (Phase 1a + 1a-revision):** the data-model foundation — entities, enums,
> contracts and the decisions everything else builds on, **including the step-graph topology**
> (decision §8: the opinionated error-handling DAG, added in the 1a-revision). **No engine runtime,
> routes, services, worker or connectors** land here; those are Phase 1b. This ADR is the contract the
> rest of the engine is built against — §8’s "Execution semantics for the orchestrator (1b-B)" is the
> normative spec the run orchestrator implements.

> **Implementation status (updated 2026-06-08).** The "Phase 1b" forward-references below are the
> ORIGINAL phasing and are now **shipped**. Implemented and merged to `dev`: Phase 1a + 1a-revision
> (this ADR); Phase **1b** — the full engine runtime (`WorkflowEngineModule`, the run orchestrator +
> `workflow-run` BullMQ worker + the PENDING / AWAITING_INPUT / RUNNING reconcilers, the transactional
> outbox in `access-grants.service`, the REST / WEBHOOK_OUT / MANUAL connectors, test-connection +
> dry-run, the `workflow:*`-gated definition / run / manual-task endpoints, the dedicated engine
> ServiceAccount, `LAST_ACTIVE_GRANT` enforcement); and the **1c builder UI**. The slice was hardened
> against an adversarial security + correctness audit (advisory-lock on the concurrent-revoke
> deprovision race, manual-resume recovery, off-worker retry backoff, the `workflow:manage` vs
> `workflow:secrets` SoD gate). Read the "Phase 1b" notes below as **done**, not "future".

## Context

The CEO mandate: lazyit's **Access pillar** ([[0023-access-management-design]]) records *intent* — IT
decides "this person should have access to Jira" by creating an [[access-grant]]. Today that is the
end of it; provisioning the user in the external system is manual. The Applications Workflow Engine
makes that external effect **optionally automatable, per application**: an `Application` may own
workflows bound to a `(application, trigger)` pair that provision / deprovision the user in the
external system when access changes.

The forces:

- **Opt-in is the load-bearing default.** An application with no enabled workflow must behave
  **exactly as today** — granting access just records the `AccessGrant`, one indexed lookup of
  overhead, nothing fires. The feature can never tax the un-automated path.
- **The grant must never be held hostage to a third-party API.** A failing Jira call must not roll
  back, block or 503 the local grant. This is the **opposite** of the Zitadel identity mirror, which
  is deliberately synchronous and strongly coupled because an identity split-brain is a security drift
  ([[0043-zitadel-source-of-truth]] §3 / INV-5). Here the grant is the source of truth; external
  provisioning is an eventually-consistent **downstream effect**.
- **Runs are durable, multi-step, and can pause for a human** — for arbitrary durations — without a
  parked worker. They must survive a restart and never lose or double-execute a trigger.
- **It is an admin-operated SSRF cannon and a secrets vault**, so egress control and credential
  handling are first-class from day one.
- **Substrate is already paid for.** [[0053-async-workers-bullmq-valkey]] (accepted 2026-06-07)
  explicitly names this engine as one of its two justifiers and rejected pg-boss "because it would
  have to be replaced exactly when the workflow engine lands. This is that moment." Marginal infra
  over ADR-0053 is a couple of queues and a few tables, not a new container.
- **Scope discipline is the dominant *product* risk.** Every area design flagged drift toward
  HR / onboarding / Identity-Governance / iPaaS. The line must be bright and encoded.

## Considered options

### Execution substrate (the CEO's headline question)

- **Synchronous in-request** — *rejected as the engine; kept as the no-workflow default.* It
  re-creates the Zitadel-style coupling we must avoid, makes lazyit's own access bookkeeping hostage
  to every external app's uptime, cannot pause for a human, and dies on restart. ("No workflow
  configured = record the grant exactly as today" is *correctly* synchronous, as are
  `testConnection` / `dryRun`.)
- **pg-boss (Postgres-only, zero new infra)** — *rejected as the broker; its instinct kept.* The
  honest winner of the literal operator-simplicity test, but ADR-0053 already commits Valkey for
  other features, so shipping a second job system is adopt-then-discard; it also lacks first-class
  flows and does per-app rate-limiting poorly. Its one correct instinct — *run state belongs in
  Postgres* — we adopt anyway, which keeps the executor swappable (pg-boss stays a documented
  fallback if ADR-0053 is ever reverted).
- **Temporal** — *rejected, concepts stolen.* Technically ideal (deterministic replay, saga,
  signals, durable timers) but a multi-service platform with its own server, datastore, UI and a
  second programming model — a violation of the single-host, IT-generalist, "boring durable
  technology" constraint. We steal its ideas (saga compensation, signal-driven resume, version
  pinning) on the substrate we already run; kept only as a far-future executor-swap escape hatch.
- **n8n** — *rejected as the engine.* A peer *product*: its own secret vault, RBAC and audit, none
  integrated with ours, and it still wouldn't solve SSRF. Allowed later only as a `webhook_out`
  *target* for the long tail.
- **BullMQ on self-hosted Valkey (chosen)** — ratifies [[0053-async-workers-bullmq-valkey]], with the
  binding clarification that **BullMQ is transport, PostgreSQL is the system of record**.

### Workflow definition storage

- **Fully normalized step tables** — a migration every time an integration type or field is added;
  per-version immutability becomes awkward. Rejected.
- **Header + zod-validated jsonb step graph (chosen)** — the [[0007-flexible-asset-specs-jsonb]] /
  [[0042-article-versioning-and-linking]] precedent: a queryable `WorkflowVersion` header + an
  immutable `steps` jsonb (a discriminated union keyed on step kind), atomically snapshot-able and
  replayable. A `WorkflowStep` is a *logical* node inside the jsonb, not a v1 table.
- **Graph edges: in-jsonb `onSuccess`/`onFailure` fields vs a normalized edges table** —
  *in-jsonb chosen* (decision §8). The success/failure transitions are stored as **optional fields on
  each step object** referencing sibling step **keys** (or a terminal token), not rows in a separate
  edges table. Rationale: the edges are part of the **same immutable, atomically-snapshot-able
  definition** as the nodes (one `WorkflowVersion` = one self-contained graph; pinning stays a single
  jsonb read, no join, no second versioned table); the [[0007-flexible-asset-specs-jsonb]] discipline
  (zod validates the jsonb on write) already gives us referential + acyclicity checks at the edge with
  **no migration** when the edge vocabulary grows. An edges table would buy queryable topology we don't
  need in v1 (the builder reads the whole version anyway) at the cost of a join on every replay and a
  second append-only table to keep in lockstep.

### Secret storage

- **Reuse the Settings `SystemSecret` store** — the original area-design proposal. **Dropped** (see
  Decision): the engine brings its **own** AES-256-GCM store (`WorkflowSecret`) — one key axis per
  subsystem, no cross-coupling to the settings module's lifecycle.

## Decision

Adopt **BullMQ-on-Valkey as transport with PostgreSQL as the durable system of record**, and model
the engine as an **opt-in extension of the Access pillar**. The Phase-1a foundation lands the
entities, enums and `@lazyit/shared` contracts below.

### 1. The decoupling invariant (non-negotiable — the inverse of INV-5)

The engine fires from a domain event emitted **after the `AccessGrant` transaction commits — never
inside it**. A failing external call **never** rolls back, blocks or 503s the grant. The grant is the
durable audit fact; an un-provisioned external account is a recoverable operational state surfaced as
a `FAILED` run + notification, not a split-brain. A regression here (making provisioning synchronous
inside the grant tx) must be locked by an invariant test in Phase 1b.

### 2. Postgres is the system of record

Run state, the pinned definition version, idempotency keys, the manual-task state and the audit
ledger live in Postgres. A BullMQ job carries only `{ workflowRunId }`. A Valkey flush is a
**reconcile/replay**, not data loss — and keeps the executor swappable.

### 3. Idempotency rule

A unique `idempotencyKey` of `(trigger, accessGrantId)` yields **at most one `WorkflowRun` per grant
event**. **Retries live *inside* a run** as `WorkflowStepRun.attempt` rows, never as new runs. **The
run is the idempotency unit; the step is the retry unit.** A captured external-id correlation
(`WorkflowStepRun.externalCorrelationId`) lets a `revoke` deprovision the **exact** account the grant
created. (The transactional outbox is the `PENDING WorkflowRun` row itself, written inside the grant
`$transaction`; an after-commit hook enqueues, and a sweeper covers the crash window — Phase 1b.)

### 4. The entity model (Phase 1a)

ID and lifecycle types follow [[0005-id-strategy]] / [[0006-soft-delete-and-auditing]] exactly.

**Configuration — mutable, soft-delete, `cuid()`:**

- **`ApplicationWorkflow`** — the opt-in binding `(applicationId, trigger, enabled)`; carries the
  `deprovisionPolicy` flag (decision 6a) and the engine `ServiceAccount` reference
  (`executedAsServiceAccountId`). A **partial unique index** on `(applicationId, trigger)
  WHERE "deletedAt" IS NULL` (raw SQL) makes "the engine fires the workflow that matches"
  deterministic while letting a soft-deleted binding free the slot. The active definition is the
  *latest* `WorkflowVersion` (no denormalized pointer — avoids a circular FK).
- **`WorkflowConnection`** — the per-app connector instance: a `kind` discriminator, a zod-validated
  jsonb `config`, and a `secretId` **reference** to `WorkflowSecret` (credentials are never inlined).

**Definition — immutable, append-only, `autoincrement()`:**

- **`WorkflowVersion`** — the replayable snapshot: `workflowId`, monotonic `version`, the immutable
  `steps` jsonb (a discriminated step list), `@@unique([workflowId, version])`, and author
  attribution (human-XOR-SA, at-most-one CHECK — the [[0042-article-versioning-and-linking]]
  precedent). Every run pins the version it executed.

**Execution & humans — append-only ledger + one mutable task:**

- **`WorkflowRun`** — `cuid()`, append-only ledger, one row per fired event: `workflowId`, the pinned
  `workflowVersionId`, denormalized `applicationId`, `trigger`, `accessGrantId`, the unique
  `idempotencyKey`, `status`
  (`PENDING → RUNNING → AWAITING_INPUT → SUCCEEDED | FAILED | COMPENSATED`), **dual actor
  attribution** — the triggering human-XOR-SA (`triggeredById` / `triggeredBySaId`, at-most-one CHECK,
  inherited from the grant) **plus** the engine's own `executedAsServiceAccountId` (a separate axis,
  not in the CHECK) — lifecycle timestamps and a **redacted** `error` summary.
- **`WorkflowStepRun`** — `autoincrement()`, append-only, **one row per attempt** (the
  [[0033-asset-history-event-model]] precedent): `runId`, `stepIndex`/`stepKey`, `attempt`, `status`,
  the captured `externalCorrelationId`, and **redacted** outcome `metadata` only (status code,
  duration, error class, mapped field *names* — never bodies / secrets / PII, [[0031-logging-strategy]]
  / INV-6).
- **`ManualTask`** — `cuid()`, **mutable lifecycle, NO soft-delete** (COMPLETED / CANCELLED are
  statuses): `runId`, `stepKey`, `assigneeId`/`cohort`, `prompt`, the human-provided `input`,
  `status`, and completion attribution (human-XOR-SA, at-most-one CHECK). Surfaced through the
  notification bell/SSE inbox.

**Secrets — mutable, soft-delete, `cuid()`:**

- **`WorkflowSecret`** — the engine's **own** encrypted credential store: `applicationId` (+ optional
  `connectionId`) scoping, a non-secret `label`, and the AES-256-GCM at-rest envelope (`ciphertext`,
  `iv`, `authTag`, `keyVersion`). Never stores cleartext; the read API exposes only a redacted
  `configured` descriptor (the [[0048-service-accounts]] `tokenPrefix` pattern). The encryption
  *service* is Phase 1b — this is the column shape only.

FK strategy: **Restrict** on history-bearing / ownership FKs (an app or workflow with history can't be
hard-deleted; soft delete bypasses); **SetNull** on actor and cross-reference FKs (losing an actor
never blocks deletion, the audit row survives). No `Cascade` is used — every child here carries audit
value, and the ledger parents are append-only and never hard-deleted, so auditability-by-default wins.

### 5. The engine brings its OWN encrypted secret store

The area designs assumed reuse of the Settings `SystemSecret` store. **That coupling is dropped.** The
engine ships its own AES-256-GCM store (`WorkflowSecret`) so credential handling is governed by the
engine's own lifecycle and RBAC (`workflow:secrets`, separation of duties) rather than the settings
module's. Same crypto primitive, separate key axis and table; secrets are write-only on the API,
redacted in dry-run / test / audit, and never logged (INV-6).

### 6. The three CEO decisions, encoded

**(a) Multi-grant deprovision = LAST_ACTIVE_GRANT by default.** Because a user may hold several active
grants on one app ([[0023-access-management-design]], no uniqueness), revoking one grant deprovisions
externally **only when the last active grant for that user+app is revoked** — never cutting off a user
who still holds legitimate access. Modeled as a per-`ApplicationWorkflow` `deprovisionPolicy` enum
(`LAST_ACTIVE_GRANT | EACH_GRANT`, default `LAST_ACTIVE_GRANT`). Enforcement is Phase 1b; this ADR
ships the field + enum.

**(b) Egress v1 = public destinations only.** The central egress guard (already shipped on the base
branch: parse-not-sniff scheme allowlist, deny resolved private/loopback/link-local/`169.254.169.254`/
reserved IPs, pin the resolved IP against DNS rebinding, re-validate every redirect) denies private by
default. v1 ships **public-only**; connector configs enforce `https`. **Roadmap (near-term):**
on-prem / internal-target connectors via an explicit, audited, per-connector internal-target allowlist
(`localhost`/`127.0.0.1`/`::1`/IMDS never allowlistable). This is a **real priority** — the LATAM
market lazyit targets barely uses cloud, so on-prem provisioning (on-prem AD/LDAP, `vpn.corp.local`)
is a first-class future integration — but it is **not** v1.

**(c) Scope = Access-pillar provisioning ONLY** — not HR / onboarding, not Identity Governance, not an
iPaaS, not n8n. v1 manual steps collect **typed input + STATIC (admin-typed) suggestions** only. The
v1 mapper offers only fields that exist (`grantee.email / firstName / lastName / id` + application +
grant context) — **no `role` / `team` / `manager` / AD tokens**. "Which team? / which manager?" is a
**manual task**. The future role/team/manager/AD identity layer is a **separate, model-first ADR — NOT
this engine** (a clearly-marked stub in the design docs; no identity fields are added here).
Re-certification stays "**re-run the workflow + emit a report**", never an attestation / SoD / IGA
subsystem. n8n is never embedded — only a `webhook_out` target later.

### 7. Connector model & phased scope

A `kind` discriminator selects a connector (mirroring the in-tree `IdentityProvider` factory:
capability flags, not `instanceof`). **v1 ships `REST` + `WEBHOOK_OUT` + `MANUAL`** — the declarative
tier (zero code per app), the 80%-value path covering the Jira worked example end-to-end (create on
grant, deactivate on revoke, "which team?" as a manual step). `SDK` / `MCP` / `PREBUILT` / `CUSTOM`
are **reserved enum slots with no behavior** (code-backed tiers shipped *in the image*, never
runtime-loaded). Data mapping is **logic-less by construction** (a template over a frozen, allowlisted
context — no `eval` / `Function` / `vm`); the safe templating + per-destination encoding is Phase 1b.
The two AccessGrant-derived **triggers** (`ACCESS_GRANTED` / `ACCESS_REVOKED`) are v1;
`TIMER_AFTER_GRANT` / `SCHEDULED` / `RECERTIFICATION` are reserved slots for the later timer phase
(DB-row-as-truth, materialized into BullMQ delayed/repeatable jobs).

### 8. Topology — an opinionated error-handling DAG (Phase 1a-revision)

> **CEO mandate (2026-06-08):** "si enviamos un http request y lo ponemos como cumplido porque espera
> una respuesta, y si es 500 o 404? hay que tener control de errores, no podemos hacerlo lineal, va en
> contra de las normas de cualquier automatización: no tiene tolerancia a errores o alertas." The
> original synthesis modelled v1 as a **linear** step sequence (`docs/workflow-engine/_synthesis.md`
> §2.4). That is **superseded here**: a flow with no error tolerance is the anti-pattern. The engine is
> a **directed acyclic graph with first-class success/failure edges** — but a deliberately
> **opinionated, finite** one, **not** an n8n-style free-form business-condition canvas (rejected as
> the engine in *Considered options*). The reconciliation: the **degenerate** DAG is exactly the old
> linear sequence, so the common case stays trivial to author.

The step contract (`@lazyit/shared` `workflow.ts`, the `WorkflowVersion.steps` jsonb) gains three
additive, **optional** dimensions — **no Prisma migration** (the shape lives inside the existing
`steps` jsonb, ADR-0007). Each is backward compatible: a version authored before this revision still
validates and resolves.

**(a) Per-step SUCCESS CRITERIA.** A REST / WEBHOOK_OUT step carries an optional `successCriteria` —
an explicit set of status codes and/or inclusive ranges. A response **outside** the criteria (e.g.
`500`, `404`) is a step **FAILURE**, never a silent "succeeded because we got a response". When unset,
the default success window is **`2xx`** (`DEFAULT_HTTP_SUCCESS_RANGE` = 200–299). The shared pure
predicate `isHttpStatusSuccess(status, criteria?)` is the single classifier both `api` (executor) and
`web` (builder preview) use.

**(b) Per-step RETRY POLICY.** A step carries an optional `retry` = `{ maxAttempts (1–10, default 1),
backoff (fixed | exponential), delayMs (≤ 1h) }`. The **contract only carries the policy**; the BullMQ
worker (1b-B) executes the attempts (mapping onto its `attempts`/`backoff`). A retry only happens when
the handler marked the failure `retryable` (transient **and**, for a create, idempotent — the
`zitadel-management.service.ts` posture): `maxAttempts` caps **how many**, the handler gates
**whether**. Omitting `retry` ⇒ a single attempt (`DEFAULT_RETRY_POLICY`).

**(c) First-class TRANSITIONS — a finite, opinionated set (NO business-condition edges).** Each step
carries optional `onSuccess` / `onFailure` edges that reference a sibling step **key** or a **terminal
token**. There are deliberately **no** arbitrary boolean / expression conditions on an edge in v1 — the
only branch points are *success* and *failure-after-retries*.

- `onSuccess` → a step **key** | **`END_SUCCESS`** (terminal: run `SUCCEEDED`).
- `onFailure` (after retries exhausted) → a step **key** (an alert / compensation / error-handler step)
  | **`ESCALATE_TO_MANUAL`** (spawn a `ManualTask`, run `AWAITING_INPUT`) | **`COMPENSATE`** (run the
  saga compensations, run `COMPENSATED`) | **`STOP_FAIL`** (run `FAILED` + emit the
  `workflow.run_failed` alert).

The legacy flat `onError` enum (`fail` / `continue` / `manual`) is **kept on the wire and superseded**
by the transition model: it is the fallback when `onFailure` is unset, mapped canonically as
`fail → STOP_FAIL`, `continue → take the success edge (fall through)`, `manual → ESCALATE_TO_MANUAL`.

**The degenerate (linear) case.** A plain ordered `steps` array with **no** explicit edges still
validates and means: **`onSuccess` → the next step in array order (else `END_SUCCESS`),
`onFailure` → `STOP_FAIL`**. A simple sequence is just the degenerate DAG; the web builder authors the
common case without drawing a single edge.

**DAG validity is enforced at the contract edge (zod refinements + tests):** step keys are unique and
may **not** collide with a reserved terminal token; every explicit `onSuccess`/`onFailure` resolves to
a known step key or the right *kind* of terminal (a success edge may not target a failure terminal and
vice-versa); and the **effective** graph (after default + legacy resolution) is **acyclic** (DFS
three-colour cycle detection). The entry node is **`steps[0]`**.

**Open for richer conditions later — without a migration.** Because the topology is jsonb (ADR-0007),
a future phase can add edge predicates, parallel fan-out (BullMQ Flows — a latent capability), or extra
terminals by **extending the zod step shape**, never by altering a table. v1 keeps the edge vocabulary
finite **on purpose** (scope discipline §6c); the *data model* is already a graph.

#### Execution semantics for the orchestrator (1b-B)

The contract above is what the 1b-B run orchestrator **must** implement; this is the normative walk of
a run over the pinned `WorkflowVersion.steps`:

1. **Start.** The entry node is `steps[0]`. The run goes `PENDING → RUNNING`; a cursor points at the
   current step key.
2. **Execute the current step** via its `StepHandler`, honouring its `retry` policy (the worker's
   `attempts`/`backoff`); each attempt is one append-only `WorkflowStepRun` row.
3. **Classify the outcome** into `SUCCEEDED | FAILED | AWAITING_INPUT` (for an HTTP step, SUCCEEDED is
   `isHttpStatusSuccess(status, step.successCriteria)`; everything else is FAILED).
4. **Resolve the edge** with the shared `resolveStepTransitions(steps, index)` (the single source of
   truth — do not re-derive):
   - **on SUCCEEDED** → follow `onSuccess`. A step **key** ⇒ set the cursor there and loop to (2).
     `END_SUCCESS` ⇒ terminal: run `SUCCEEDED`, `finishedAt` set.
   - **on FAILED** (only **after** the retry policy is exhausted and the handler stopped marking the
     failure `retryable`) → follow `onFailure`:
     - a step **key** ⇒ set the cursor to that handler/alert/compensation step and loop to (2);
     - `ESCALATE_TO_MANUAL` ⇒ create a `ManualTask`, transition the run to **`AWAITING_INPUT`**, and
       **let the BullMQ job complete** (no held worker — the pause costs one Postgres row);
     - `COMPENSATE` ⇒ run the compensation pass (below), then run **`COMPENSATED`**;
     - `STOP_FAIL` ⇒ run **`FAILED`** (redacted `error` summary) and emit the `workflow.run_failed`
       alert.
   - **on AWAITING_INPUT** (a MANUAL step’s own pause) → identical `AWAITING_INPUT` handling; the
     manual `onSuccess`/`onFailure` edges are taken on task **completion** / **cancellation**.
5. **Pause / resume.** While `AWAITING_INPUT` there is **no** BullMQ job in flight. On manual-task
   completion the typed input is merged into the frozen mapping context (`ctx.steps[<key>]`), a
   **resume job** is enqueued, the run returns to `RUNNING`, and the walk continues from the manual
   step’s `onSuccess`; on cancellation it follows the manual step’s `onFailure`.
6. **Compensation pass (saga).** `COMPENSATE` (or a compensation handler reached via an `onFailure`
   step key) runs the **already-succeeded** steps’ compensations in **reverse** completion order, each
   recorded as a `WorkflowStepRun` with status `COMPENSATED`. Compensation is **best-effort** and
   **never touches the `AccessGrant`** (the decoupling invariant §1 holds: the grant is never rolled
   back).
7. **Terminal mapping.** `END_SUCCESS → SUCCEEDED`; `STOP_FAIL → FAILED`; `COMPENSATE → COMPENSATED`;
   `ESCALATE_TO_MANUAL → AWAITING_INPUT` (then resolves on task completion). Idempotency is unchanged
   (decision §3): the **run** is the idempotency unit, the **step** is the retry unit; a Valkey flush
   is a reconcile/replay against Postgres, never a re-fire.

Acyclicity (enforced at author time) guarantees this walk **terminates**: every path reaches a terminal
token or an `AWAITING_INPUT` pause; it can never loop.

## Consequences

- **Positive:**
  - A correct, complete keystone: the data model encodes the decoupling, idempotency, append-only
    audit and actor-attribution invariants at the schema level (partial-unique + three at-most-one
    CHECK constraints), so Phase 1b builds on guarantees, not conventions.
  - Zero-overhead opt-in default: an un-automated app pays one indexed lookup.
  - One shared contract (`@lazyit/shared`) for the enums, the discriminated connector/step config
    unions and the entity wire shapes — `api` and `web` agree by construction; secrets never appear
    on a wire shape.
  - **Error tolerance is structural, not optional** (§8): every step has an explicit success criterion,
    a bounded retry policy and first-class success/failure edges, validated as an acyclic graph at the
    contract edge. A 500/404 can never masquerade as success, and the orchestrator walks one normative
    spec (`resolveStepTransitions`) shared with the builder — no per-side drift.
  - The engine is executor-swappable (Postgres-as-truth) and its secret/RBAC governance is its own.
- **Negative / trade-offs (accepted):**
  - **A second encrypted secret store** (`WorkflowSecret`) alongside the settings `SystemSecret` — two
    AES-256-GCM code paths and two key considerations to back up. Accepted for clean separation of
    duties and lifecycle.
  - **Append-only ledgers grow** (`WorkflowRun` / `WorkflowStepRun`); a retention / archival policy is
    a Phase-2 follow-up.
  - **`WorkflowConnection` ↔ `WorkflowSecret` is bidirectional** (the connection's credential
    reference + the secret's optional connection scope), modeled as two nullable named relations —
    flagged for CTO review.
  - On-prem / internal targets, timer triggers and the code-backed connector tiers are **deferred**
    (reserved enum slots), so v1 does not serve the on-prem-heavy market yet.
- **Follow-ups (Phase 1b and beyond):** the `WorkflowsModule` (definition CRUD) +
  `WorkflowEngineModule` (executor, queue, step handlers, listener, sweeper); the after-commit trigger
  wiring into `access-grants.service.ts` (`create` / `revoke` / `batchRevoke`) with the
  no-rollback invariant test; the `SecretEncryptionService` for `WorkflowSecret`; the deprovision-policy
  enforcement; per-app rate limiting + sandboxed processors; the manual-task inbox on the bell/SSE
  stack; later — inbound `webhook_in` (HMAC + replay + single-use token), the dedicated egress-isolated
  worker container, the on-prem internal-target allowlist, timer triggers, and the code-backed
  connector tiers.

Related: [[0053-async-workers-bullmq-valkey]] · [[0048-service-accounts]] · [[0046-roles-permissions-v2]] ·
[[0043-zitadel-source-of-truth]] · [[0042-article-versioning-and-linking]] ·
[[0041-soft-delete-reuse-and-restore]] · [[0035-search-architecture]] · [[0033-asset-history-event-model]] ·
[[0031-logging-strategy]] · [[0030-list-pagination-contract]] · [[0023-access-management-design]] ·
[[0007-flexible-asset-specs-jsonb]] · [[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] ·
`docs/workflow-engine/_synthesis.md`
