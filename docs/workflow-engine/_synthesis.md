---
title: "Applications Workflow Engine — Architecture Synthesis"
tags: [workflow-engine, architecture, synthesis, access, adr-candidate]
status: draft-for-ceo
created: 2026-06-07
updated: 2026-06-07
authors: [chief-architect]
reconciles:
  - "[[domain-product]]"
  - "[[backend]]"
  - "[[orchestration-substrate]]"
  - "[[integrations-connectors]]"
  - "[[devops-infra]]"
  - "[[security]]"
  - "[[frontend]]"
---

# Applications Workflow Engine — Architecture Synthesis

> This is the **chief-architect reconciliation** of the seven area designs in `docs/workflow-engine/`.
> It is the single coherent picture: the recommended execution substrate, the consolidated data
> model, the connector model, the security posture, a phased roadmap from a minimal v1 to the full
> vision, the scope guardrails, and the decisions only the CEO can make. Where the specialists
> disagreed, the resolution is stated explicitly (see [[#Reconciled conflicts]]).
>
> **Source of truth precedence:** the area docs are the depth; this file is the binding summary.
> Where this file and an area doc disagree, this file wins — then the area doc is updated.

---

## 0. The one-paragraph answer

Build the engine as an **opt-in extension of the Access pillar** ([[0023-access-management|ADR-0023]]):
an `Application` may own workflows bound to a `(application, trigger)` pair; an application with no
enabled workflow behaves **exactly as today** — granting access just records the `AccessGrant`, no
automation, a single indexed lookup of overhead. Run it on the substrate
[[0053-async-workers-bullmq-valkey|ADR-0053]] already brings in — **BullMQ on a self-hosted Valkey** —
but with one binding rule that resolves almost every cross-area tension:

> **BullMQ executes steps; PostgreSQL remembers everything.**

The durable system of record — run state, pauses, the versioned definition, idempotency keys,
DB-defined timers, the full audit ledger — lives in the lazyit Postgres. BullMQ/Valkey is only the
muscle: at-least-once hand-off, retry/backoff, delayed/repeatable jobs, sandboxed processors,
per-app rate-limiting. The local grant is the **source of truth**; external provisioning is a
**decoupled, eventually-consistent downstream effect** that fires *after* the grant transaction
commits and **never** rolls back or blocks the grant — the deliberate inverse of the Zitadel
strong-coupling ([[0043-zitadel-source-of-truth|ADR-0043]] / INV-5), and closer to the
Meilisearch fire-and-forget posture ([[0035-search-architecture|ADR-0035]]).

---

## 1. Execution substrate — the CEO's question, answered

**Recommendation: BullMQ on self-hosted Valkey (ratify [[0053-async-workers-bullmq-valkey|ADR-0053]]),
with all durable run-state, pauses, versioning and audit in PostgreSQL.**

All seven specialists independently reached the same verdict. The reasoning is not "BullMQ is
trendy" — it is that the substrate decision is *already made and already paid for*:

- **ADR-0053 is accepted (2026-06-07)** and explicitly names **this engine** as one of its two
  justifiers ("multi-step flows with parent/child dependencies"). It also explicitly **rejected
  pg-boss as primary** because it lacks first-class flows "and would have to be replaced exactly
  when the workflow engine lands. **This is that moment.**"
- **Marginal infra over ADR-0053 is zero.** Valkey is arriving regardless — for the `.docx`
  decompression-bomb fix (SEC-002), grant auto-expiry, and backups-from-frontend. The engine adds
  **a couple of queues and a few tables**, not a new container. The load-bearing
  one-command-`docker compose up` operator constraint
  ([[product-vision-tech|product vision]] §"Target operator profile") is therefore **already met**.
- The substrate's only real weaknesses versus a heavyweight durable engine — multi-day human waits
  and definition versioning/replay — **are closed in Postgres** (see §2, §3), which is exactly where
  lazyit already keeps append-only history ([[0006-soft-delete-and-auditing|ADR-0006]]).

### Why not the alternatives (consolidated)

| Option | Verdict | Why |
| --- | --- | --- |
| **Synchronous in-request** | Rejected as the engine; **kept as the no-workflow default** | Re-creates the Zitadel-style coupling we must avoid, makes lazyit's own access management hostage to every external app's uptime, cannot pause for humans, dies on restart. But "no workflow configured = record the grant exactly as today" is *correctly* synchronous, as are `testConnection` and `dryRun` (bounded, read-only, interactive). |
| **pg-boss (on existing Postgres)** | Rejected as primary; **documented fallback** | The *honest* winner of the literal operator-simplicity test (zero new infra, jobs already inside the nightly `pg_dump`) — DevOps flags this candidly. It loses only because (a) ADR-0053 already commits Valkey for other features, so shipping a *second* job system on one host is strictly worse, and (b) it lacks flows/parent-child and does per-app rate-limiting poorly. **It becomes the correct choice only if the CEO reverts ADR-0053** — and because our run state lives in Postgres (not the broker), the design stays broker-agnostic enough to swap. |
| **Temporal** | Rejected | Technically ideal (deterministic replay, built-in saga, signals = manual resume, durable timers = scheduled triggers) but a multi-service platform with its own server, datastore (a 3rd DR item), UI and a second programming model. That violates the single-host, IT-generalist, "boring durable technology" constraint. We **steal its concepts** (saga compensation, signal-driven resume, version pinning) on the substrate we already run. Kept only as a far-future executor-swap escape hatch. |
| **n8n** | Rejected as the engine | A peer *product*, not a substrate. It would fork the three trust-sensitive subsystems we just hardened — its own secret vault, its own RBAC, its own audit — none integrated with `SystemSecret`/INV-6, the [[0046-roles-permissions-v2|ADR-0046]] catalog, or the INV-SA-4 actor model — and still wouldn't solve SSRF. **Allowed only as a `webhook_out` *target*** later (Phase 4) so an operator's own n8n/Make/Zapier reaches the 400+ long-tail for ~zero lazyit effort. |

### Strongest dissent (surfaced honestly)

DevOps' "pg-boss wins the *literal* load-bearing test" is the strongest minority position and the
right thing for the CEO to hear: if you ever doubt the Valkey container, pg-boss is a real,
operator-simpler v1. The synthesis still chooses BullMQ+Valkey **only because ADR-0053 already pays
the Valkey cost for unrelated features** — adopting pg-boss now would be adopt-then-discard. If
ADR-0053 is reverted, this recommendation flips to pg-boss without changing the data model.

---

## 2. The architectural keystones (all seven agree)

These five rules are the spine. They are what make a *light* substrate sufficient.

1. **Postgres is the system of record; BullMQ is transport.** A BullMQ job carries only
   `{ workflowRunId }` (and a step pointer). Run/step/task rows, the version snapshot, idempotency
   keys and timers are Postgres. A Valkey flush becomes a **reconcile/replay**, not data loss.
   This also keeps the executor swappable (the pg-boss fallback and the Temporal escape hatch both
   depend on this).

2. **Decoupling is non-negotiable (the inverse of INV-5).** The engine fires from a domain event
   emitted **after** the `AccessGrant` transaction commits — never inside it. A failing external
   call **never** rolls back, blocks, or 503s the grant. The grant is the durable audit fact
   ([[0023-access-management|ADR-0023]]); an un-provisioned external account is a recoverable
   operational state surfaced as a FAILED run + notification, not a split-brain. A regression here
   (someone making provisioning synchronous inside the grant tx) must be locked by an invariant test.

3. **Human pauses = DB state + event-driven resume, never a held job.** A manual step (or an
   inbound webhook callback) transitions the run to `AWAITING_INPUT` in Postgres, the BullMQ job
   **completes** (freeing the worker), a human is nudged via the notification bell/SSE stack
   (ADR-0052), and a **resume job is enqueued on submit**. A multi-day wait costs **one Postgres
   row**, not a worker. **Long-held / sleeping jobs are a banned anti-pattern.** *This is the
   load-bearing reason we do not need Temporal.*

4. **Step-at-a-time re-enqueue, not a BullMQ Flow tree (for v1).** The grant/revoke trigger fires
   one **linear** sequence; modelling it as re-enqueued single-step jobs is what lets a run pause
   indefinitely at no cost. BullMQ's flow/parent-child capability (the feature ADR-0053 cited
   against pg-boss) remains a **latent** capability for future *parallel fan-out* (e.g. provisioning
   into several sub-systems at once) — it is **not** the backbone of the pausable linear run. (See
   [[#Reconciled conflicts|conflict #2]].)

5. **At-least-once delivery + effectively-once provisioning.** A unique `idempotencyKey` of
   `(trigger, accessGrantId)` yields **at most one `WorkflowRun` per grant event**; retries live
   *inside* a run as `WorkflowStepRun.attempt` rows, never as new runs. **The run is the idempotency
   unit; the step is the retry unit.** Each external call also carries a per-step idempotency key;
   non-idempotent creates are single-shot (`retryOnTransient: false`, the
   `zitadel-management.service.ts` precedent), 4xx is never retried, 5xx/429 is retried with
   backoff. A captured external-id correlation lets `revoke` deprovision the **exact** account the
   grant created.

---

## 3. Consolidated data-model sketch

ID and lifecycle types follow [[0005-id-strategy|ADR-0005]] and
[[0006-soft-delete-and-auditing|ADR-0006]] exactly as the existing codebase does. Three tiers:

**A. Configuration — mutable, soft-delete, `cuid()`**

- **`ApplicationWorkflow`** — the binding `(applicationId, trigger, enabled)`; carries the
  multi-grant deprovision policy (see CEO Q1) and the engine ServiceAccount reference. The "is this
  app automated?" lookup; cached so the opt-in default stays one indexed read.
- **`WorkflowConnection`** (the connector **instance**) — per-application transport + auth config as
  zod-validated `jsonb` ([[0007-flexible-asset-specs-jsonb|ADR-0007]]), with credentials stored as
  **references** into the ADR-0052 `SystemSecret` store (never inlined).

**B. Definition — immutable, append-only, `autoincrement()`**

- **`WorkflowVersion`** — the replayable snapshot. Steps are embedded as a zod-validated `jsonb`
  `steps[]` (a discriminated union keyed on the connector `kind`/`integrationType`), atomically
  snapshot-able as one unit (the [[0042-knowledge-base-depth|ArticleVersion]] precedent).
  **Every run pins the version it executed** so editing a definition never corrupts an in-flight or
  paused run. A `WorkflowStep` is a *logical node inside the jsonb*, not a v1 table.

**C. Execution & humans — append-only ledger + one mutable task**

- **`WorkflowRun`** — `cuid()`, append-only ledger, one row per fired event. Holds the unique
  `idempotencyKey`, the pinned `workflowVersionId`, status (`PENDING → RUNNING → AWAITING_INPUT →
  SUCCEEDED | FAILED | COMPENSATED`), and **dual actor attribution**: `triggeredBy`
  (human-XOR-ServiceAccount, inherited from the grant) + `executedAsSaId` (the engine's own SA),
  via the [[0048-service-accounts|ADR-0048]] at-most-one-actor CHECK (INV-SA-4).
- **`WorkflowStepRun`** — `autoincrement()`, append-only, **one row per attempt** (the
  [[0033-asset-history-event-model|AssetHistory]] precedent for queryable normalized rows). Carries
  the per-step idempotency key, the captured external-id correlation, and **redacted** outcome
  metadata only (ADR-0031, no bodies, no secrets).
- **`ManualTask`** — `cuid()`, mutable-lifecycle, **no soft-delete**. Assignee/cohort, a typed input
  schema, status, completion actor (human-XOR-SA). Surfaced through the notification bell/SSE inbox.

> **The transactional outbox is the run row itself.** Inside the grant `$transaction`, the engine
> does one indexed lookup of "apps with an enabled workflow for this trigger" and, if matched,
> inserts a `PENDING WorkflowRun`. The durable fact is the **row**, not the enqueue. An after-commit
> hook enqueues the BullMQ job; a periodic **sweeper** re-enqueues any `PENDING` run whose job was
> lost in the crash window. No separate generic outbox table is needed. (See
> [[#Reconciled conflicts|conflict #1]].)

---

## 4. Connector model (the "automate ANY app" requirement)

Three layers (the [[integrations-connectors|integrations]] design, the clearest framing):

1. **Connector *type*** — framework-level: a shipped executor + a zod config schema, selected from a
   registry keyed on a `kind` discriminator that mirrors the in-tree
   `apps/api/src/auth/identity/identity-provider.factory.ts` (capability flags, not `instanceof`).
2. **Connector *instance* (`WorkflowConnection`)** — admin-configured per application, reusable
   across that app's workflows.
3. **Step** — binds an instance to an *operation* + a *data mapping*.

**Two tiers of connector type:**

- **Declarative tier** — `rest`, `webhook_out`, `webhook_in`, `manual`, `mcp`: configured purely as
  zod-validated `jsonb`, **zero code per app**. This is the honest answer to "automate any app": any
  HTTP API, any automation-platform bridge, any human task, any MCP target.
- **Code-backed tier** — `sdk` / `prebuilt` / `custom`: shipped **in the image** and selected by
  registry key — **never runtime-loaded code** (a hard security rule). Phased later; the model slots
  are reserved now so MCP/prebuilt never force a schema change.

**Data mapping is logic-less by construction:** a template over a **frozen, allowlisted `ctx`** with
a **closed filter set** and mandatory executor-side context-aware encoding (JSON/URL/header/argv).
**No `eval`, no `Function`, no `vm`, no arbitrary helpers**, with prototype-pollution guards. Every
lazyit field flowing outward (display name, free-form `accessLevel`, unvalidated app metadata) is
**untrusted** — this is an SSTI→RCE and downstream-injection sink, so logic-less + frozen ctx +
per-destination encoding closes both classes. JMESPath is considered only if logic-less proves
insufficient; a general evaluator never is.

**v1 ships the `rest` + `manual` + `webhook_out` trio** — the 80%-value path that covers the Jira
worked example end-to-end (create on grant, deactivate on revoke, "which team?" as a manual step).

---

## 5. Security posture (consolidated)

Two threats dominate: the engine is, by construction, an **admin-operated SSRF cannon** and a
**secrets vault**.

- **Egress guard — the single most important new control.** Every outbound call passes one central,
  tested guard: scheme allowlist via **parse-not-sniff**, deny resolved IPs in
  private/loopback/link-local/`169.254.169.254`/reserved ranges, **pin the resolved IP** (defeat DNS
  rebinding), and **re-validate every redirect**. The SEC-008/SEC-051 prefix-sniff bypass history
  becomes the test corpus. **Recommended posture: deny-private-by-default with an explicit, audited,
  per-connector internal-target allowlist** — because the product legitimately calls internal hosts
  (ADR-0023 allows `vpn.corp.local`; on-prem AD is a first-class future target) — where
  `localhost`/`127.0.0.1`/`::1` and IMDS are **never** allowlistable. (CEO Q4.)
- **Secrets** reuse the ADR-0052 `SecretEncryptionService` (AES-256-GCM, `SETTINGS_ENCRYPTION_KEY`):
  one at-rest crypto path, one key to back up. The API is **write-only** (returns
  `configured: boolean`, never cleartext/ciphertext), secrets are redacted in dry-run/test/audit and
  **never logged** (INV-6, ADR-0031). OAuth2-with-refresh likely needs a small ADR-0052 extension
  (the store was designed for static SMTP-style secrets).
- **No arbitrary code execution**, run inside a **BullMQ sandboxed forked-child processor with a
  heap cap** — the same isolation that closes SEC-002 for the docx bomb. Until the worker is split
  out (Phase 2), this child + heap cap is the **only** isolation boundary, and it holds decrypted
  secrets — which is why the dedicated worker container is more urgent here than for the docx job.
- **Audit** is the append-only `WorkflowRun`/`WorkflowStepRun` ledger, attributed
  human-XOR-ServiceAccount via the INV-SA-4 CHECK, recording the executed version + redacted
  outcome metadata only. The engine executes as a **dedicated least-privilege ServiceAccount**
  (ADR-0048, `apps/api/src/common/actor.service.ts` `resolveActor`), never a fabricated human,
  never ADMIN.
- **Manual-task completion** requires `workflow:task` **AND** an assignee/cohort match (permission
  alone is the IDOR trap); human-typed values are zod-validated as untrusted input and never treated
  as an expression.
- **Inbound `webhook_in`** is the only externally-reachable write surface — deferred to Phase 2 but
  its contract is fixed now: **HMAC + replay protection + single-use per-run token + size/rate
  limits before any work**, or it is a run-hijack/DoS vector.

**New RBAC domain** (extends the frozen [[0046-roles-permissions-v2|ADR-0046]] catalog-as-code in
`packages/shared/src/schemas/permission.ts`): `workflow:read`, `workflow:manage` (configure engine +
connections), `workflow:run` (manually trigger / re-run / retry), `workflow:task` (complete a manual
task), and a **distinct `workflow:secrets`** for separation of duties between logic authors and
credential holders (the [[security]] lane's strongest point). Safe-default seed = **ADMIN-only**,
configurable with the ⚠ delegation UX. Touching this enum can break the web's exhaustive permission
maps (per MEMORY) — web `tsc` + golden/parity tests must pass before merge.

---

## 6. Scope guardrails — Access-pillar provisioning, NOT HR / IGA / iPaaS

Every specialist flagged scope drift as the dominant *product* risk. The line is bright:

- **This is Access-pillar provisioning. Full stop.** Not HR/onboarding (an explicit anti-goal,
  [[product-vision-tech|product vision]] §"What lazyit is not"), not Identity Governance, not an
  iPaaS, not n8n.
- **The v1 mapper offers only fields that exist:** `grantee.email / firstName / lastName / id` +
  `application` + grant context. **No `role` / `team` / `manager` / `boss` / AD tokens** — they would
  dangle and pressure the `User` model toward HR/IGA.
- **"Which team? / which manager?" is a *manual task*** with optional **static** suggestions — not a
  new identity model.
- **The future role/team/manager/AD identity fields are a separate, model-first decision/ADR**,
  explicitly **not** driven by this engine.
- **The future re-certification timer trigger stays "re-run the workflow + emit a report"** — never
  an attestation-campaign / SoD / role-mining / access-review subsystem (that is the IGA line).
- **n8n is never embedded** — only a `webhook_out` target (Phase 4) for the long tail.

---

## 7. Phased roadmap

### Phase 0 — Prerequisites (not engine work; hard gate)

- Land **[[0053-async-workers-bullmq-valkey|ADR-0053]]** on `dev` (Valkey in `compose.yaml`,
  `@nestjs/bullmq` + `ioredis`, base queue module, pilot = async `.docx` import). Currently on
  `feat/issue-247-async-workers-bullmq-valkey`, **not yet wired**.
- Land **ADR-0052** (SystemSecret + Notifications/bell/SSE) on `dev`. Currently on
  `feat/settings_notifications_smtp`, **not yet merged**. (See the ADR-numbering note below.)
- Add the `workflow:*` permissions to the `@lazyit/shared` catalog + golden/parity tests + web
  `tsc`.
- Build the **central egress guard** as shared infra (it is substrate-independent and the make-or-
  break control).

### Phase 1 — Minimal v1 (the Jira case; opt-in; zero-overhead default)

- **Model:** `ApplicationWorkflow` + `WorkflowConnection` + `WorkflowVersion` + `WorkflowRun` +
  `WorkflowStepRun` + `ManualTask`.
- **Triggers:** `access.granted` + `access.revoked` via the run-row transactional outbox +
  after-commit enqueue + sweeper, wired surgically into
  `apps/api/src/access-grants/access-grants.service.ts` (`create` / `revoke` / `batchRevoke`).
  **Opt-in:** no enabled workflow ⇒ behaves exactly as ADR-0023 today.
- **Connectors:** `rest` + `manual` + `webhook_out`; per-app encrypted credentials;
  `testConnection` + `dryRun` (synchronous, read-only); idempotency + correlation capture;
  logic-less mapping.
- **Execution:** BullMQ step-at-a-time, Postgres run state, decoupled from the grant, retry/backoff,
  sandboxed processor, engine-as-ServiceAccount attribution, best-effort saga compensation on
  terminal failure (never touches the grant).
- **Human:** manual step → `AWAITING_INPUT` → bell/SSE inbox → resume on completion.
- **UX:** per-Application **"Workflows" tab** (primary, discovery-first) + the cross-app console
  under the existing empty `apps/web/app/(app)/settings/integrations/` route; a **list-based step
  builder** (not a node-graph canvas); write-only secret fields; a run timeline reusing the
  asset-history visual grammar; the manual-task inbox on the bell/SSE (polled fallback if ADR-0052
  is late).
- **RBAC:** `workflow:read / manage / run / task / secrets`.

### Phase 2 — Breadth & robustness

Inbound `webhook_in` (HMAC + replay + single-use token); **dedicated egress-isolated worker
container** (host sized 6–8 GB; resolves the only real footprint jump and isolates decrypted-secret
handling); cross-process SSE fanout via **Valkey pub/sub** (the fanout ADR-0052 deferred); `mcp`
connector (sandboxed, argv arrays); OAuth2-refresh secret extension; run reports/exports +
failure-visibility (digest/dashboard widget, no-spam); run-ledger retention/archival +
detach-and-retain on soft-delete; SSRF network segmentation.

### Phase 3 — Time / scheduled triggers

Delayed/repeatable BullMQ jobs (N-days-after-grant; periodic re-run) reconciled from **DB-defined
timers** at boot (a schedule reconciler — timers are Postgres rows, not broker state).
Re-certification = **re-run + report only** (IGA guardrail). `sdk` / `prebuilt` code-backed
connectors for famous apps.

### Phase 4 — Long tail & polish

Prebuilt connector gallery; **"call an n8n / Make / Zapier webhook"** as one adapter for the 400+
long tail; richer reporting. *(Separately, and model-first — **not** this engine — the future
identity-fields ADR, if/when the org decides.)*

---

## 8. Reconciled conflicts

1. **Trigger durability — outbox vs after-commit + sweep.** Domain & Orchestration wanted a
   transactional outbox; Backend & DevOps proposed an after-commit event + reconciliation sweep
   with the outbox as a later "stronger fix." **Resolved:** adopt the transactional outbox from v1,
   realized as the **`PENDING WorkflowRun` row written inside the grant `$transaction`** (Domain's
   lean form — no separate outbox table) + after-commit enqueue + a sweeper for the crash window.
   Auditability-by-default forbids a silently-dropped trigger. (CEO Q2 confirms.)

2. **BullMQ Flows vs step-at-a-time.** ADR-0053 and Frontend leaned on flows/parent-child; Backend,
   Orchestration and Domain insisted on step-at-a-time re-enqueue. **Resolved:** step-at-a-time is
   the backbone (it is what makes pausing free); flows remain a **latent** capability for future
   *parallel fan-out*, not the run backbone. pg-boss's lack of flows is still a valid reason to
   prefer BullMQ for the future shape, but v1 does not lean on it.

3. **Multi-grant deprovision semantics.** Domain proposed per-grant (with "still-has-access" as
   opt-in step logic); Orchestration recommended deprovision-only-when-no-other-active-grant.
   **Resolved:** make it a **per-app policy flag on `ApplicationWorkflow`**, default
   **deprovision-only-when-last-active-grant-is-revoked** (safer — never cuts off a user who still
   holds legitimate access). (CEO Q1 confirms the default.)

4. **RBAC verb granularity.** Three different splits across the docs. **Resolved:**
   `workflow:read / manage / run / task` **+ a distinct `workflow:secrets`** (Security's
   separation-of-duties point). Whether `task` opens to MEMBER and whether `secrets` folds into
   `settings:manage` are CEO Q3.

5. **AOF framing.** ADR-0053 says "AOF so jobs survive a restart"; DevOps says treat Valkey as
   rebuildable with Postgres as system-of-record. **Resolved:** Postgres is the system of record;
   **AOF stays on as a convenience** to shrink the restart-replay window — correctness comes from the
   run row + sweeper/reconciler regardless. (Minor; no decision needed.)

6. **Worker topology / host sizing.** Co-located (4 GB, per ADR-0053) vs dedicated worker (6–8 GB).
   **Resolved:** v1 **co-located** (stays +1 container / 4 GB); **dedicated egress-isolated worker
   in Phase 2** with a documented 6–8 GB bump — driven by egress isolation + decrypted-secret
   handling, not just load. (CEO Q6 is the host-sizing acknowledgement.)

7. **ADR-numbering collision (flag, not a conflict).** The specialists and the CTO references call
   the Settings/Notifications/SMTP ADR "**ADR-0052**", but on `dev`/`master`
   `docs/03-decisions/0052-*` is **CI parallel-docker** and `0053-*` is the **BullMQ/Valkey** ADR.
   The Settings ADR was numbered 0052 on its unmerged branch before 0052 was taken on `dev`. **It
   must be renumbered when `feat/settings_notifications_smtp` merges.** This synthesis follows the
   specialists' convention ("ADR-0052 = Settings/Notifications") for readability — do not confuse it
   with the CI ADR.

---

## 9. Open questions for the CEO

1. **Multi-grant deprovision:** confirm the default is **deprovision-only-when-last-active-grant-is-
   revoked**, exposed as a per-app policy flag (per-grant remains opt-in step logic)?
2. **Trigger durability:** approve the **transactional outbox** (the `PENDING` run row written in
   the grant `$transaction`) from v1 over the lighter after-commit + sweep?
3. **RBAC:** confirm `workflow:read / manage / run / task` **+ a distinct `workflow:secrets`**. Does
   `workflow:task` open to MEMBER (day-to-day ops) or stay ADMIN-only? Does `workflow:secrets` fold
   into the existing `settings:manage`?
4. **Egress posture (the SSRF crux):** **deny-private-by-default + explicit per-connector audited
   internal-target allowlist** (recommended) vs allow-any-non-loopback — with `localhost`/IMDS never
   allowlistable either way?
5. **Engine principal:** auto-create a dedicated least-privilege **ServiceAccount** at setup
   (recommended) vs admin picks the SA per workflow?
6. **Failure visibility & host sizing:** bell-only vs an email digest vs a dedicated
   provisioning-failures view (respecting the no-spam anti-goal)? And: is the **6–8 GB / 4 vCPU**
   Phase-2 host bump acceptable for the target market, or must the engine fit 4 GB indefinitely
   (which pins us to the co-located worker)?
7. **Scope line (confirm all):** v1 manual steps = typed input + **static** suggestions only;
   role/team/manager/AD stays a future **model-first ADR**, not this engine; re-certification =
   **re-run + report**, never an attestation/IGA subsystem; **n8n only as a `webhook_out` target**,
   never embedded.
8. **Sequencing & numbering:** confirm **ADR-0052 (Settings/Notifications) and ADR-0053
   (BullMQ/Valkey) land on `dev` before Phase 1**, and authorize **renumbering** the Settings ADR on
   merge to resolve the 0052 collision.

---

## See also

- [[_MOC]] — index of every area design + this synthesis.
- [[0053-async-workers-bullmq-valkey]] · ADR-0052 (Settings/Notifications, on branch) ·
  [[0048-service-accounts]] · [[0046-roles-permissions-v2]] · [[0043-zitadel-source-of-truth]] ·
  [[0035-search-architecture]] · [[0023-access-management]] · [[0007-flexible-asset-specs-jsonb]] ·
  [[0006-soft-delete-and-auditing]] · [[0005-id-strategy]]
