---
title: "Workflow Engine — Domain & Product Architecture"
tags: [design, workflow-engine, access, domain, product]
status: proposed
created: 2026-06-07
deciders: [Joaquín Minatel]
area: Domain & Product architecture
---

# Workflow Engine — Domain & Product Architecture

> **Lens:** this document models the Applications workflow engine **inside the lazyit domain** —
> the entity set, lifecycle hooks, idempotency, trigger taxonomy, audit/attribution and the
> scope guardrails. It does **not** specify the per-integration connection shapes (REST/webhook/
> SDK/MCP/manual/connectors — the *Integration & Security* lane owns those), the execution
> wiring (the *Substrate/Backend* lane owns the BullMQ/Valkey plumbing of ADR-0053), or the UI
> (the *Frontend* lane). It defines the **nouns and the rules** every other lane builds on.
>
> **No schema / code / migrations here** — entity field tables are design documentation in the
> style of `docs/02-domain/entities/*.md`, not Prisma.

---

## 1. TL;DR

An **Application** can OPTIONALLY own one or more **workflows**, each bound to a `(application,
trigger)` pair, that automate provisioning / deprovisioning in the *external* system when access
changes inside lazyit. **Opt-in is the load-bearing default**: an application with no enabled
workflow behaves *exactly as today* (ADR-0023) — `POST /access-grants` records the
[[access-grant]] and nothing else fires.

The domain is modeled as: a mutable, soft-deletable **`ApplicationWorkflow`** (the binding) and
**`WorkflowConnection`** (the per-app integration config), an **append-only `WorkflowVersion`**
(the immutable, replayable definition snapshot), and the execution ledger — an append-only
**`WorkflowRun`** per fired event, append-only **`WorkflowStepRun`** rows per attempt, and a
mutable **`ManualTask`** for human-in-the-loop steps.

The grant is the **source of truth**; provisioning is a **downstream, decoupled, eventually-
consistent effect** — the explicit *contrast* to the Zitadel strong-coupling of
[[0043-zitadel-source-of-truth]] (INV-5). A failing external call **never** rolls back or blocks
the local grant. One grant → at most one run per trigger, enforced by a DB idempotency key.

**Substrate verdict (domain lens):** the domain genuinely needs **durable, multi-step,
restart-surviving runs that can pause for a human** → **synchronous is wrong**, **Temporal and
n8n are the wrong weight/shape**, and **BullMQ-on-Valkey ([[0053-async-workers-bullmq-valkey]])
is the right execution layer** — provided the **durable system of record stays in the lazyit DB**
(the run/step/task rows + idempotency keys + DB-defined timers), with the broker as the muscle,
not the truth. Human pauses are **DB state + event-driven resume**, never a worker parked for
days. Full reasoning in §16.

---

## 2. What exists today (the trigger source)

- **[[application]]** — the catalog row. Has `metadata` (jsonb, unvalidated, ADR-0007). No
  workflow concept yet. `apps/api/src/applications/`.
- **[[access-grant]]** — append-only `user ↔ application` join; `revokedAt = null` ⇒ active;
  multi-grant allowed (no uniqueness); actor attributed human-XOR-service-account
  (`grantedById`/`grantedBySaId`, `revokedById`/`revokedBySaId` + at-most-one CHECK, ADR-0048).
  `apps/api/src/access-grants/access-grants.service.ts` — `create()` and `revoke()` are the two
  hook points for v1. `expiresAt` is informative; **no scheduler revokes at expiry** today
  ([[0023-access-management-design]], deferred in ADR-0053).
- **The two write paths we hook:** `AccessGrantsService.create()` (→ `ACCESS_GRANTED`) and
  `AccessGrantsService.revoke()` (→ `ACCESS_REVOKED`). `batchRevoke()` fans out to one event per
  grant (preserving the per-grant idempotency, §9).

Adjacent, **do not conflate** (§4): **[[access-request]]** is the *pre-grant approval* workflow
(deferred); this engine is the *post-grant provisioning* effect. AccessRequest → approve →
AccessGrant → **this engine fires**. Two different workflows; the approval one is out of scope.

---

## 3. Reused foundations (dependencies, flag these)

| We reuse | From | What for | Status caveat |
| --- | --- | --- | --- |
| **Encrypted secret at rest** (`SystemSecret` + redacted `SettingAuditLog`) | **ADR-0052** | per-app credentials (Jira token / OAuth secret / etc.) — workflow tables store a **reference**, never a secret (INV-6) | ⚠ ADR-0052 lives on `feat/settings_notifications_smtp`, **not yet on `dev`**. This engine **hard-depends** on it landing first. |
| **Notifications + in-app bell + SSE realtime + fail-soft email** | **ADR-0052** | the **ManualTask inbox** and **run-status** surfacing (a manual step raises a Notification; a run failure notifies the configurer) | same caveat |
| **ServiceAccount** principal + at-most-one-actor audit pattern | **ADR-0048** / INV-SA-1..4 | *who/what* a run executes **as** and *who* completed a manual task (human XOR SA) | on `dev` ✅ |
| **Flexible jsonb validated by zod** | **ADR-0007** | the workflow **definition** + step **config**/**data-mapping** live as zod-validated jsonb | on `dev` ✅ |
| **Permission catalog-as-code** | **ADR-0046** / INV-8 | a new `workflow` permission domain (§15) | on `dev` ✅; touching the shared enum needs a web `tsc` pass (exhaustive maps) |
| **Structured logging, bodies never logged** | **ADR-0031** / INV-6 | step runs persist **redacted** metadata only (status code, error class, duration) — never request/response bodies or mapped PII | on `dev` ✅ |
| **Offset pagination `Page<T>`** | **ADR-0030** | run/task list endpoints | on `dev` ✅ |
| **Durable broker (BullMQ on Valkey)** | **ADR-0053** | the execution/scheduling layer (§16) | accepted 2026-06-07; this engine is one of the two features that justified it |

---

## 4. Scope & drift guardrails (read this before designing anything)

This engine is **Access-pillar provisioning** and nothing more: it automates the *external
effect* of an [[access-grant]] lifecycle change. The following are **explicit non-goals**; any PR
that edges toward them must be flagged 🚩 and escalated.

- 🚩 **Not an HR / onboarding system** ([[product-vision-tech]] "What lazyit is not"). The manual
  "which team? / who is the manager?" steps (§14) and the future identity fields (§15-stub) are
  the **edge** — they describe *access provisioning inputs*, never employee lifecycle, equipment,
  payroll, or org structure. Keep manual inputs as *free, per-step values feeding one external
  call*; do **not** grow a modeled org/person graph.
- 🚩 **Not an IGA / access-certification platform.** The future `RECERTIFICATION` timer (§7) must
  stay "re-run the provisioning workflow and/or emit a report", **not** a certification-campaign
  subsystem (reviewers, attestation states, SoD policy, role mining). If that demand appears it
  is its own product decision, not a feature creep here.
- 🚩 **Not a general-purpose iPaaS / n8n.** Triggers are **AccessGrant-derived** (+ timers tied to
  grants), never arbitrary event sources; targets are **the application's own external system**,
  not arbitrary HTTP automations. The engine is *narrow by construction*.
- 🚩 **Not a new identity authority.** Provisioning writes to the *external* app via its
  connection credential; it does **not** mutate lazyit identity, roles, or permissions, and it is
  **not** on any authN path.

**Opinionated-vs-configurable carve-out:** lazyit is "opinionated over configurable" *except this
feature is explicitly admin-configurable* (the CEO's mandate). The configurability is bounded to
*the workflow definition + the connection*; the *engine's domain rules* (idempotency,
append-only audit, decoupling) are opinionated and non-negotiable.

---

## 5. The entity set

```
Application (existing)
  └─ 0..N ApplicationWorkflow        (binding: application + trigger)         [mutable, soft-delete]
        └─ 1..N WorkflowVersion      (immutable definition snapshot)           [append-only]
  └─ 0..N WorkflowConnection         (per-app integration config + secret ref) [mutable, soft-delete]

AccessGrant (existing) ──fires──▶ WorkflowRun     (one per fired event)        [append-only ledger]
                                     ├─ N WorkflowStepRun (one per attempt)     [append-only log]
                                     └─ 0..N ManualTask   (human-in-the-loop)   [mutable lifecycle]
```

### 5.1 `ApplicationWorkflow` — the binding (mutable, soft-delete)

The opt-in record that says "application X automates trigger T". Holds the *pointer* to the active
definition; the definition itself is the immutable `WorkflowVersion`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | exposed/handled entity (ADR-0005). |
| `applicationId` | `cuid` FK → [[application]] | `onDelete: Restrict` (a workflow's app can't be hard-deleted; soft-delete bypasses, same nuance as AccessGrant). |
| `trigger` | enum `WorkflowTrigger` | `ACCESS_GRANTED` \| `ACCESS_REVOKED` (v1); `TIMER_AFTER_GRANT` \| `SCHEDULED` \| `RECERTIFICATION` reserved (§7). |
| `name` | `string` | admin label. |
| `description` | `string?` | |
| `isEnabled` | `boolean` `@default(false)` | a disabled workflow never fires (still records nothing extra on grants). |
| `currentVersionId` | FK → `WorkflowVersion` | the active definition a new run snapshots from. |
| `connectionId` | `cuid?` FK → `WorkflowConnection` | the integration this workflow drives (usually the app's one connection). |
| `createdAt`/`updatedAt`/`deletedAt` | | mutable domain entity (ADR-0006). |

**Uniqueness:** at most **one live, enabled** workflow per `(applicationId, trigger)` for v1 (a
deterministic "the engine fires the workflow that matches" rule). Implement as a **partial unique
index** `WHERE deletedAt IS NULL AND isEnabled` (the soft-delete-reuse pattern of
[[0041-soft-delete-reuse-and-restore]]). Multiple *disabled/draft* rows are allowed (drafting a
replacement). Multi-workflow-per-trigger is a deliberate **future** relaxation, not v1.

### 5.2 `WorkflowVersion` — the definition (append-only, immutable)

The workflow definition is **config that evolves and must be auditable/replayable**, so every
edit appends a new immutable snapshot — the exact precedent of **[[article-version]]** (ADR-0042).
A `WorkflowRun` records the **`workflowVersionId` it executed**, so a run is reproducible even
after the workflow is edited.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `autoincrement` | versioned snapshot, internal handle (ADR-0005 — log/version table). |
| `workflowId` | FK → `ApplicationWorkflow` | |
| `version` | `int` | `@@unique([workflowId, version])` — the human handle ("v3"), like ArticleVersion. |
| `definition` | `jsonb` | the **step graph** (see 5.2.1), validated by a zod schema in `@lazyit/shared` (ADR-0007). Immutable. |
| `createdById` / `createdBySaId` | FK → [[user]] / [[service-account]] | who authored this version, human XOR SA + at-most-one CHECK (ADR-0048). |
| `createdAt` | | **append-only** — no `updatedAt`, no `deletedAt`, never edited or deleted (ADR-0006). |

#### 5.2.1 `WorkflowStep` / the action graph — embedded in the definition

**Decision (v1):** the action graph lives **inside** `WorkflowVersion.definition` as zod-validated
jsonb — *not* a separate normalized `WorkflowStep` table. Rationale: the definition must be
atomically snapshot-able and replayable as one immutable unit; a normalized step table would
itself need per-version immutability, which is awkward and buys nothing at our scale. This matches
the accepted "flexible config as jsonb validated by zod" pattern (ADR-0007). Each step is a node:

```
step := {
  id:            stable string within the version,
  type:          'http' | 'webhook_out' | 'manual' | 'sdk' | 'mcp' | 'builtin' | ...   // Integration lane owns the per-type config shape
  dependsOn:     [stepId, ...],          // the DAG edges — parent/child ordering
  dataMapping:   { ... },                // lazyit data → external payload (Integration lane); a step may require ManualTask input
  config:        { ... },                // type-specific (endpoint, method, connector id, MCP tool, …)
  onError:       'fail' | 'continue' | 'manual'   // governance: escalate to a ManualTask vs hard-fail
}
```

`WorkflowStep` is therefore a **logical** entity (a node id is the stable handle a `WorkflowStepRun`
references), not a physical table in v1. *Future:* if list/search over steps becomes a real need,
normalize into a per-version immutable `WorkflowStep` table — a non-breaking addition.

### 5.3 `WorkflowRun` — one per fired event (append-only ledger)

The execution record created when a trigger fires. **Append-only lifecycle record** in the exact
sense of [[access-grant]] / [[asset-assignment]]: never deleted, identity immutable, but
designated lifecycle markers (`status`, timestamps) transition during execution.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | **exposed handle** (status polling, report rows, FK parent of steps/tasks). |
| `workflowId` / `workflowVersionId` | FKs | the binding + the **exact** version executed (replay/audit). |
| `applicationId` | FK (denormalized) | cheap "runs for this app" reporting. |
| `trigger` | enum `WorkflowTrigger` | the firing trigger. |
| `accessGrantId` | `cuid?` FK → [[access-grant]] | the **source event** for `ACCESS_GRANTED`/`ACCESS_REVOKED` (null for pure `SCHEDULED`). `onDelete: Restrict` (grants are append-only anyway). |
| `idempotencyKey` | `string` | the dedup key, **unique** (§9). |
| `status` | enum `WorkflowRunStatus` | `PENDING` → `RUNNING` → (`WAITING_MANUAL` ⇄ `RUNNING`) → `SUCCEEDED` \| `FAILED` \| `CANCELLED`. |
| `triggeredById` / `triggeredBySaId` | FK → [[user]] / [[service-account]] | **the cause** — inherited from the grant's actor — human XOR SA + at-most-one CHECK (ADR-0048). |
| `executedAsSaId` | `cuid?` FK → [[service-account]] | **the principal the run acts as** for any lazyit-side audited side effect (§13). |
| `startedAt` / `finishedAt` | `datetime?` | lifecycle markers. |
| `error` | `jsonb?` | **redacted** failure summary (class + step id), never bodies/secrets (INV-6, ADR-0031). |
| `createdAt` / `updatedAt` | | append-only-with-lifecycle (like AccessGrant: `updatedAt` allowed for status transitions; **no `deletedAt`**). |

### 5.4 `WorkflowStepRun` — one per attempt (append-only log)

Strictly append-only, the [[asset-history]] precedent: **one immutable row per execution
attempt**. A retry creates a **new** row; the current state of a step is the latest row for
`(runId, stepId)`. This keeps the table truly append-only (no in-place status churn).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `autoincrement` | child execution log, never an external handle (ADR-0005). |
| `runId` | FK → `WorkflowRun` | `@@index([runId, id])` — the per-run timeline. |
| `stepId` | `string` | the node id within the version's definition. |
| `attempt` | `int` | 1-based; a retry is a new row with `attempt + 1`. |
| `status` | enum | `SUCCEEDED` \| `FAILED` \| `WAITING_MANUAL` \| `SKIPPED`. |
| `metadata` | `jsonb?` | **redacted** — HTTP status, duration, error class, mapped *field names* (never values/bodies/PII; INV-6). |
| `manualTaskId` | `cuid?` FK → `ManualTask` | set when the step suspended for a human. |
| `createdAt` | | **append-only** (ADR-0006) — no `updatedAt`, no `deletedAt`. |

### 5.5 `ManualTask` — human-in-the-loop (mutable lifecycle entity)

For steps an external app cannot automate (no API), or steps needing human input ("which team?",
optionally with role/team suggestions — §15-stub). A **mutable lifecycle entity**: cancellation
and completion are **statuses**, not soft-deletes, so it does *not* carry `deletedAt`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | **user-facing actionable item**, linked from a Notification (ADR-0052) — needs a stable handle. |
| `runId` / `stepId` | FK / `string` | the suspended step. |
| `status` | enum | `OPEN` → (`CLAIMED`) → `COMPLETED` \| `CANCELLED`. |
| `assigneeId` | `uuid?` FK → [[user]] | optional; suggested by role/team later (§15-stub). |
| `prompt` | `string` | what the human must do/answer. |
| `input` | `jsonb?` | the value(s) the human provided — fed back into the run on completion. **Validated by zod** against the step's expected shape; **may contain PII**, so it is treated as sensitive (not logged; INV-6). |
| `completedById` / `completedBySaId` | FK → [[user]] / [[service-account]] | who resolved it, human XOR SA + at-most-one CHECK (ADR-0048). |
| `createdAt` / `updatedAt` | | mutable; **no `deletedAt`** (status is the lifecycle). |

### 5.6 `WorkflowConnection` — the per-app integration config (mutable, soft-delete)

Where the **per-app credential and connection live** (the feature's "AUTH/SECRETS per app"). The
**Integration & Security lane owns the per-type config shapes** (REST base URL + auth scheme,
inbound/outbound webhook secret, SDK/MCP endpoint, connector id, "manual", self-hosted target,
"build-the-API-ourselves"). From the **domain lens** the only invariants are:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | |
| `applicationId` | FK → [[application]] | credentials are **per app**; one connection is reused by the app's grant + revoke workflows. |
| `type` | enum `ConnectionType` | the integration kind (Integration lane defines the set + per-type config schema). |
| `config` | `jsonb` | **non-secret** connection config, zod-validated per `type` (ADR-0007). |
| `secretRef` | `string?` | a **reference** to a `SystemSecret` (ADR-0052) — the engine **never** stores a cleartext credential (INV-6). |
| `createdAt`/`updatedAt`/`deletedAt` | | mutable config (ADR-0006). |

> **Lane boundary:** §5.6 is intentionally thin. It exists so the domain has a place to hang the
> credential reference and so a run can resolve "how do I call this app". The *richness* of
> connection types is the Integration lane's deliverable.

---

## 6. ID strategy & soft-delete vs append-only (the ADR-0005 / ADR-0006 mapping)

| Entity | ID | Class | Timestamps | Why |
| --- | --- | --- | --- | --- |
| `ApplicationWorkflow` | `cuid` | mutable, **soft-delete** | `createdAt`,`updatedAt`,`deletedAt` | configuration that is edited/disabled/removed; restorable (ADR-0041). |
| `WorkflowConnection` | `cuid` | mutable, **soft-delete** | `createdAt`,`updatedAt`,`deletedAt` | per-app config; same. |
| `WorkflowVersion` | `autoincrement` | **append-only** | `createdAt` only | immutable, replayable snapshot — ArticleVersion precedent. |
| `WorkflowRun` | `cuid` | **append-only ledger** (lifecycle markers) | `createdAt`,`updatedAt`; **no `deletedAt`** | execution record; status transitions like AccessGrant's `revokedAt`. |
| `WorkflowStepRun` | `autoincrement` | **append-only log** | `createdAt` only | one immutable row per attempt — AssetHistory precedent. |
| `ManualTask` | `cuid` | mutable **lifecycle** (no soft-delete) | `createdAt`,`updatedAt`; **no `deletedAt`** | status (`COMPLETED`/`CANCELLED`) is the lifecycle. |

This is the same discipline the codebase already enforces: **mutable config → soft-delete**;
**execution/version history → append-only** ([[product-vision-tech]] "Soft-delete everywhere;
append-only where it matters"; ADR-0006).

---

## 7. Trigger taxonomy & where timers live

**v1 (build):**
- `ACCESS_GRANTED` — fired after an [[access-grant]] is created.
- `ACCESS_REVOKED` — fired after a grant is revoked (single or via batch, one event per grant).

**Reserved (stub now, build later — do not design deeply):**
- `TIMER_AFTER_GRANT` — N days after a grant (e.g. provision a trial, schedule a follow-up).
- `SCHEDULED` — cron-like periodic (e.g. drift reconciliation).
- `RECERTIFICATION` — periodic "is this access still valid?" → **bounded to re-running the
  workflow / emitting a report** (🚩 IGA drift line, §4).

**Where timers live — the domain rule:** the **source of truth for a timer is a DB row** (the
trigger + its schedule on the `ApplicationWorkflow`, plus a future `WorkflowSchedule`/run-due
record), **materialized** into BullMQ **delayed/repeatable jobs** ([[0053-async-workers-bullmq-valkey]]).
The broker is a *cache of when-to-fire*; on boot a reconciler re-creates broker jobs from the DB
rows. **Never** let the only record of a scheduled trigger live in the broker — Valkey is
restart-durable (AOF, ADR-0053) but it is not the system of record.

**Synergy, not coupling:** the long-parked **grant auto-expiry** scheduler (ADR-0053; the
"a grant past `expiresAt` stays active" gap in [[access-grant]]) is a *sibling* timer, not part of
this engine. They share the timer infrastructure; keep them as separate concerns (auto-expiry
mutates a grant; a timer trigger fires a workflow).

---

## 8. Hooking into the AccessGrant lifecycle — and the decoupling contract

### 8.1 The decoupling contract (the explicit contrast with Zitadel)

[[0043-zitadel-source-of-truth]] (INV-5) mirrors identity to Zitadel **synchronously, inside the
transaction, rolling back and 503-ing on failure** (no split-brain — identity must agree). **This
engine is the deliberate opposite.** The [[access-grant]] is **authoritative**; external
provisioning is a **downstream side effect**:

- The workflow fires **after the grant transaction commits**, never inside it.
- A failing external call **never** rolls back, blocks, or 503s the grant. The grant stands; the
  run goes to `FAILED`/`WAITING_MANUAL`, retries, and notifies (ADR-0052) — closer to the
  Meilisearch fire-and-forget posture ([[0035-search-architecture]]) than the Zitadel one.
- **Why:** access inside lazyit is the record of decision; the external system is eventually
  reconciled. Coupling the grant to a flaky third-party API would make granting access as fragile
  as that API — unacceptable for the Access pillar.

### 8.2 The outbox: don't lose a trigger, don't fire it twice

To survive a crash *between* the grant commit and the broker enqueue, use a **transactional
outbox** realized by the run row itself:

1. In `AccessGrantsService.create()`/`revoke()`, after the grant write, **in the same
   `$transaction`**, look up the enabled `ApplicationWorkflow(applicationId, trigger)`.
   - **No enabled workflow → do nothing extra.** This is the *opt-in default* — the literal
     current code path, zero new rows, negligible overhead (one indexed lookup; can be backed by
     a cached "apps-with-workflows" set).
   - **Enabled workflow exists →** insert a `WorkflowRun` with `status = PENDING` and the
     `idempotencyKey` (§9), committed atomically with the grant. *This row is the outbox entry.*
2. **After commit**, enqueue a BullMQ job `{ runId }` (jobId = run id).
3. A periodic **sweeper** picks up `PENDING` runs older than a few seconds with no live job and
   enqueues them — covering the crash window. The DB row, not the enqueue, is the durable fact.

This keeps the grant path fast and decoupled while guaranteeing **at-least-once** delivery to the
worker; the idempotency key upgrades it to **effectively-once** provisioning.

### 8.3 Emission mechanism

A small `WorkflowTriggerService` is invoked by `AccessGrantsService` (explicit call, the
[[asset-history]] "discrete events, explicit emission" precedent of ADR-0033 — **not** a hidden
interceptor). `batchRevoke()` emits **one trigger per revoked grant**, so the per-grant
idempotency (§9) holds for bulk operations exactly as for single ones.

---

## 9. Idempotency — one grant never double-provisions

**Rule:** a `(trigger, accessGrantId)` pair maps to **at most one** `WorkflowRun`. Enforced by a
**unique constraint on `idempotencyKey`** where `idempotencyKey = "<trigger>:<accessGrantId>"`
(for grant-derived triggers). Consequences:

- Re-running `create()` logic, a broker redelivery, or the sweeper racing the after-commit enqueue
  can all attempt to create the run — the unique key makes the second a **no-op that returns the
  existing run**. Exactly one provisioning sequence per grant event.
- **Retries live *inside* a run** (`WorkflowStepRun.attempt`), not as new runs — so "retry the
  failed Jira call" never creates a second user. The run is the idempotency unit; a step is the
  retry unit.
- **Multi-grant nuance:** because [[access-grant]] allows several active grants per `(user, app)`
  (ADR-0023), each grant gets its **own** run. This is correct — two distinct grants are two
  distinct access decisions. If an app should de-dupe at the *user* level (provision once per
  user, not per grant), that is **step-level logic in the definition** (the step checks external
  state / no-ops), **not** a domain-level run de-dup. Flag this to the CEO as a per-app policy
  question (§17), not a default.
- **Revoke nuance:** `ACCESS_REVOKED` keys on the same `accessGrantId`; revoking a grant fires
  exactly one deprovision run for *that* grant. If the user still holds *another* active grant on
  the same app, whether to actually deactivate them externally is, again, **step logic**, not
  domain de-dup. (This is the real-world "don't deactivate the Jira user who still has another
  active grant" case — surfaced as an open question, §17.)

---

## 10. Execution & human pauses (the part that drives the substrate)

A run executes its definition's DAG (`dependsOn` edges → parent/child ordering). The domain-
relevant property is **suspension on a manual step**:

- When a step is `type: 'manual'` (or `onError: 'manual'`), the worker writes a `WorkflowStepRun`
  with `status = WAITING_MANUAL`, creates a `ManualTask`, sets the run to `WAITING_MANUAL`, raises
  a **Notification** (ADR-0052), and **ends the job**. *The worker is not held.*
- When a human completes the `ManualTask` (providing `input`), completion **re-enqueues** a job
  that resumes the run from the suspended step. → **DB state + event-driven resume**, never a
  BullMQ job parked for hours/days.

This is the key domain-lens nuance: we get "long-running, human-pausing workflows" **without**
needing a durable-timer-for-days execution engine. The durability is *in the rows*; resumption is
*an event*. It is why we do **not** need Temporal's heavyweight model (§16).

---

## 11. Reporting, audit & governance semantics

The **`WorkflowRun` + `WorkflowStepRun` tables ARE the audit trail** (append-only, immutable —
ADR-0006). Governance surfaces ("reports / audit trails / services" from the CEO mandate):

- **Per-application provisioning history** — runs for an app, filterable by trigger/status/actor
  (`GET /applications/:id/workflow-runs`, paginated per ADR-0030). The denormalized
  `WorkflowRun.applicationId` makes this cheap.
- **Run detail** — the step-run timeline (redacted metadata), the version executed, the source
  grant, the actor, any manual tasks.
- **Operational** — open/overdue `ManualTask`s; failed runs needing attention (both surfaced via
  the ADR-0052 bell/SSE inbox).
- **Estate-wide (future, not v1):** add a `UNION ALL` branch to the `recent_activity` view
  ([[0044-dashboard-recent-activity]]) so a workflow run shows in the global activity stream —
  gated by `logs:read` (the estate-wide history permission). Note it; don't build it in v1.

**Redaction (INV-6 / ADR-0031):** step runs persist **status code, duration, error class, mapped
field *names*** — **never** request/response bodies, credentials, or mapped PII values. The
`ManualTask.input` and the per-step `dataMapping` payload may contain PII and are **never logged**;
if a payload must be inspectable for support, that is a separate, redaction-reviewed decision.

---

## 12. (intentionally folded into §11 and §13)

---

## 13. Actor attribution — human XOR ServiceAccount (ADR-0048)

Two distinct attributions, both following the **at-most-one-actor** pattern (INV-SA-4) — a nullable
human FK and a nullable SA FK with a DB CHECK that at most one is set:

1. **Triggered by (the cause).** Inherited from the grant: the human or SA that created/revoked
   the [[access-grant]] (`grantedById`/`grantedBySaId`). Copied onto `WorkflowRun.triggeredById`
   XOR `triggeredBySaId`. For a `SCHEDULED` run with no human cause, both are null (system).
2. **Executed as (the principal of lazyit-side effects).** A workflow run that performs an
   *audited lazyit-side* action (e.g. a future step that writes back into lazyit) acts **as a
   ServiceAccount** — `WorkflowRun.executedAsSaId` — never as a fabricated human, never as ADMIN
   (ADR-0048: SAs are fail-closed, direct-grant only). The external call uses the *connection
   credential* (§5.6), which is the external system's own identity, not a lazyit principal.
3. **Manual-task completion.** `ManualTask.completedById` XOR `completedBySaId` (a human resolving
   their inbox item; an SA could complete via API).

**Recommendation:** give the engine its **own ServiceAccount** (created at workflow-setup time,
scoped to exactly the permissions any write-back step needs — typically *none* in v1, since v1
only calls *out*). This makes every automated action honestly attributable to "the workflow
engine SA", queryable in the audit trail, and revocable. Flag: ADR-0048 noted the
`ServiceAccountAuditLog` has no SA-actor column yet — irrelevant to v1 (runs aren't SA-management),
but note it if SA-on-SA attribution ever appears.

---

## 14. Manual tasks & the inbox (reuse ADR-0052)

A `ManualTask` is the bridge for un-automatable steps and human-input steps. It **reuses the
ADR-0052 notification stack wholesale**:

- Creating a task → a **Notification** (the user's bell + SSE realtime + fail-soft email).
- The task is actioned in a **manual-task inbox** (frontend lane) — claim, fill `input`, complete.
- Completion re-enqueues the run (§10).

🚩 **Drift watch (§4):** the "suggest a team/manager by role" affordance is the single feature most
likely to creep toward IGA/HR. v1 keeps `ManualTask.input` as **free, zod-validated values for one
external call**, with *optional static suggestions the admin typed into the step config* — **not**
a modeled org graph and **not** a directory lookup. The richer version is the §15 stub.

---

## 15. FUTURE identity fields — STUB ONLY (do not design now)

> [!warning] Stub — explicitly out of scope for this design
> The CEO mandate lists richer identity inputs — **role, team, manager, boss, Active Directory
> integration** — as configurable mapping sources for provisioning payloads (e.g. Jira needs
> "organization, team"). **These do not exist in the lazyit model today** ([[user]] has email +
> name; no team/manager/AD).
>
> **What v1 does instead:** the data-mapping of a step draws from **existing `User` fields** +
> **`Application`/grant context** + **`ManualTask` human input** for anything missing. That is the
> complete v1 source set.
>
> **What is deferred (its own future design + ADR):** a modeled identity-attribute layer
> (team/manager/AD-synced fields, suggestion engine). When/if it lands it plugs into the **manual-
> input seam** (§14) and the **step `dataMapping`** — *no other entity here changes*. 🚩 This is the
> **IGA/HR boundary** (§4): designing it now would pull lazyit toward Identity Governance and an
> HR/onboarding system, both explicit anti-goals ([[product-vision-tech]]). **Do not model
> person/org graphs in this engine.** Escalate to the CEO as a separate product decision.

---

## 16. Substrate verdict — from the domain lens

**The CEO's question:** is BullMQ + Redis/Valkey right, overkill (Temporal), a separate product
(n8n), or could something simpler (pg-boss / synchronous) do?

**What the *domain* demands (the requirements, derived above):**
1. **Decoupling** from the grant write (§8) — must NOT be synchronous-in-transaction.
2. **Durable, restart-surviving runs** — a crash mid-run must neither lose nor double-execute (§8.2, §9).
3. **Multi-step DAGs with ordering/dependencies** (`dependsOn`) — parent/child flows (§5.2.1).
4. **Human pauses of arbitrary duration** — but modeled as **DB state + event resume**, not a parked job (§10).
5. **Retries with backoff** per step; **delayed/repeatable** scheduling for the future timer triggers (§7).
6. **Operator-legible, single-host, one-command** ([[product-vision-tech]] operator profile).

**Verdict, option by option:**

- ❌ **Synchronous execution.** Re-introduces exactly the Zitadel strong-coupling we deliberately
  reject for Access (§8.1): a flaky external API would make granting access fragile, can't pause
  for a human, and loses everything on restart. Violates requirements 1, 2, 4. **No.**

- ⚠️ **pg-boss on the existing Postgres (zero new infra).** The most attractive on the
  operator-cost axis, and **the domain model is broker-agnostic** — our durable truth is the DB
  rows + idempotency keys (§16-principle below), so pg-boss *could* drive it. **But** [[0053-async-workers-bullmq-valkey]]
  already evaluated and **rejected pg-boss as the primary** precisely because it lacks first-class
  **flows / parent-child dependencies** (requirement 3 — the workflow engine's core need) and has
  weaker rate-limiting + a thinner NestJS ecosystem; it would have to be **replaced exactly when
  this engine lands**. Since that ADR is **accepted (2026-06-07)** and the Valkey container is
  already decided, the "zero new infra" advantage is *already spent*. Choosing pg-boss now would
  mean adopting-then-discarding. **No (the infra decision is made).**

- ❌ **Temporal (heavier durable-workflow engine).** Overkill for a 5–20-person self-hosted tool:
  its own server + datastore + SDK + the determinism/replay programming model is real operator
  and developer weight, violating requirement 6 and the one-command-setup constraint. Crucially,
  **we don't need its signature feature** — durable multi-day execution timers — because we model
  human pauses as DB state + event resume (§10), not as suspended executions. Our durability is a
  handful of explicit, auditable Postgres rows, which is *simpler and more legible* for an IT
  generalist than a Temporal cluster. **No.**

- ❌ **n8n (separate automation product).** Wrong shape and a scope violation: it is another
  container, another UI, another auth/RBAC model, and it would move the workflows *out* of the
  lazyit domain — no `ApplicationWorkflow` entities, no [[0046-roles-permissions-v2]] gating, no
  [[0048-service-accounts]] attribution, no [[access-grant]] coupling, no shared audit trail.
  Adopting it is also the §4 "general-purpose iPaaS" drift. **No.**

- ✅ **BullMQ on Valkey ([[0053-async-workers-bullmq-valkey]]) — the right execution layer**, with
  one domain-imposed constraint:

> **Domain principle: the durable system of record is the lazyit DB, not the broker.** The truth
> of "what runs exist, in what state, executing which version, idempotent on which key, with which
> timers due" lives in `WorkflowRun` / `WorkflowStepRun` / `ManualTask` / `WorkflowVersion` +
> idempotency keys + DB-defined schedules (§7, §8.2, §9). **BullMQ/Valkey is the *muscle*** —
> at-least-once delivery, retries+backoff, delayed/repeatable jobs, parent/child flows — **a cache
> of work-to-do reconciled *from* the DB** (the outbox + the sweeper + the boot-time schedule
> reconciler). This makes the engine broker-swappable in principle, keeps replay/audit in
> Postgres, and means a Valkey wipe degrades to "re-derive jobs from PENDING/due rows", never
> "lost provisioning".

This is consistent with ADR-0053, which **explicitly names this engine** ("multi-step flows with
parent/child dependencies") as one of the two features that justified the durable broker — so the
domain need and the chosen substrate already agree. The work here is to ensure the **domain
contracts (decoupling, DB-as-truth, idempotency, append-only audit) constrain how the substrate is
used**, not to re-pick the substrate.

---

## 17. Phased, v1-first plan

**Phase 0 — unblock (not this lane, but a hard gate).** ADR-0052 (`SystemSecret`, Notifications,
SSE) must merge to `dev`; ADR-0053 (BullMQ/Valkey) infra must land. This engine builds on both.

**Phase 1 — the binding + the opt-in no-op path (domain foundation).**
- `ApplicationWorkflow`, `WorkflowVersion`, `WorkflowConnection` entities + the `workflow` permission
  domain (§15-RBAC below). Config CRUD (admin-configurable).
- The `WorkflowTriggerService` hook in `AccessGrantsService` that **does nothing** when no enabled
  workflow exists — proving the opt-in default is the current behavior, with tests.

**Phase 2 — `ACCESS_GRANTED` end-to-end, single step.**
- The outbox (run row in the grant tx), after-commit enqueue, sweeper, idempotency key.
- `WorkflowRun` / `WorkflowStepRun` execution for **one HTTP step** (the simplest integration type;
  Integration lane provides the connection/credential).
- Run-status surfacing via ADR-0052 notifications. Worked example: Jira "create user".

**Phase 3 — `ACCESS_REVOKED` + multi-step DAG + retries.**
- The revoke trigger (incl. `batchRevoke` fan-out), `dependsOn` ordering, per-step retry/backoff,
  the `onError` policy.

**Phase 4 — `ManualTask` + human-in-the-loop.**
- Suspension (`WAITING_MANUAL`), the inbox (frontend), event-driven resume (§10). The un-automatable
  "manual" step type and the "which team?" *static-suggestion* input.

**Phase 5 — governance & reporting.**
- Per-app run history, run detail, failed-run/overdue-task surfacing; (later) the `recent_activity`
  UNION branch.

**Deferred (stubbed, not built):** timer/scheduled/re-certification triggers (§7); the richer
identity-field mapping (§15); multi-workflow-per-trigger; prebuilt connectors (just seeded
`WorkflowVersion` templates + a connection type — Integration lane).

### RBAC extension (Phase 1, §15-RBAC)

Extend the frozen catalog ([[0046-roles-permissions-v2]], `packages/shared/src/schemas/permission.ts`)
with a `workflow` domain — **proposed**:
- `workflow:read` — view workflows, runs, reports.
- `workflow:write` — configure workflows + connections (the admin-configurable surface).
- `workflow:run` — manually trigger / retry / cancel a run.
- `workflow:task` — claim/complete a `ManualTask` (separate so a non-configurer can action an
  assigned task without `workflow:write`).

Seed default: all four ADMIN; `workflow:read` + `workflow:task` reasonably MEMBER (CEO call). ⚠
Touching the shared permission enum breaks exhaustive maps on the web — run the web `tsc` + the
golden parity tests before merge (MEMORY: shared-changes-need-web-typecheck).

---

## 18. Open questions for the CEO

1. **De-dup policy per app:** when a user holds *multiple* active grants on one app, should
   `ACCESS_REVOKED` actually deactivate them externally only when the **last** grant is revoked?
   (§9). Proposed default: provision/deprovision **per grant**, with "still-has-access" handling as
   *opt-in step logic*, not a domain default. Confirm.
2. **Engine ServiceAccount:** auto-create one engine SA at setup (recommended, §13), or let the
   admin pick the SA each workflow "executes as"? Affects setup UX.
3. **`workflow:task` granularity:** is a dedicated manual-task permission worth it, or fold task
   completion into `workflow:run`? (§17-RBAC).
4. **Failure visibility:** beyond the bell, do failed runs need an email digest / a dashboard
   widget for the configurer? (Cheap on ADR-0052; confirm appetite.)
5. **Re-certification scope (🚩):** confirm `RECERTIFICATION` stays "re-run + report" and does NOT
   become an attestation-campaign subsystem (§4 IGA line).

---

## 19. Dependencies on other lanes

- **Integration & Security lane:** the `ConnectionType` set + per-type `config`/`dataMapping`
  schemas; how a step actually calls REST/webhook/SDK/MCP/connector/manual targets; credential
  storage *mechanics* on top of the `SystemSecret` reference (§5.6). This doc only fixes the seam.
- **Substrate / Backend lane:** the BullMQ/Valkey wiring (flows, delayed/repeatable jobs,
  sandboxed processors), the outbox sweeper, the boot-time schedule reconciler (§8.2, §16).
- **Frontend lane:** the workflow builder, the run-status views, the manual-task inbox (on the
  ADR-0052 notification stack).
- **ADR-0052** (hard prerequisite): `SystemSecret` + Notifications/SSE must be on `dev`.

---

Related: [[0023-access-management-design]] · [[access-grant]] · [[application]] · [[access-request]] ·
[[0053-async-workers-bullmq-valkey]] · [[0043-zitadel-source-of-truth]] · [[0048-service-accounts]] ·
[[0046-roles-permissions-v2]] · [[0007-flexible-asset-specs-jsonb]] · [[0006-soft-delete-and-auditing]] ·
[[0005-id-strategy]] · [[0030-list-pagination-contract]] · [[0031-logging-strategy]] ·
[[0033-asset-history-event-model]] · [[0042-knowledge-base-depth]] · [[0044-dashboard-recent-activity]] ·
[[0035-search-architecture]] · [[INVARIANTS]] · [[product-vision-tech]]
