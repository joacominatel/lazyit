# Applications Workflow Engine (epic #248) — STATUS

_As of 2026-06-08. Temporary — see [README](README.md)._

## 1. The goal (one paragraph)

For each `Application`, an admin can OPTIONALLY define configurable **workflows** that automate
provisioning/deprovisioning in the EXTERNAL system when access changes inside lazyit (triggers: access
granted / revoked; later: timers). Worked example = Jira: grant access → create the user there; revoke
→ deactivate. No workflow configured ⇒ granting access just records the `AccessGrant` exactly as today
(ADR-0023). Scope is **Access-pillar provisioning ONLY** — not HR/onboarding/IGA/iPaaS.

## 2. Architecture (the binding decisions)

- **Substrate:** BullMQ on self-hosted **Valkey** (ADR-0053). The rule: **"BullMQ executes; PostgreSQL
  remembers."** All durable run state / pauses / versioning / audit live in Postgres; the broker is
  at-least-once transport only. Human pauses = DB state (`AWAITING_INPUT`) + event-driven resume (no
  held jobs) ⇒ no Temporal needed. Honest fallback if Valkey is ever dropped: pg-boss (zero new infra).
- **Decoupling (INVERSE of the Zitadel mirror, INV-5):** the engine fires AFTER the `AccessGrant` tx
  commits, never inside it. A failing external call NEVER rolls back/blocks the grant. Trigger
  durability = a transactional outbox (a `PENDING WorkflowRun` row written in the grant tx) +
  after-commit enqueue + a sweeper.
- **Idempotency:** unique `(trigger, accessGrantId)` ⇒ at most one run per grant event; the run is the
  idempotency unit, the step is the retry unit.
- Full design: `docs/workflow-engine/_synthesis.md` (binding) + the 7 area docs; formalized in
  **ADR-0054**.

## 3. CEO decisions locked in

- **Multi-grant revoke:** deprovision ONLY when the **last active grant** for that user+app is revoked
  (never cut off a user who still holds access). Per-app policy flag, default `LAST_ACTIVE_GRANT`.
- **Egress v1:** public destinations only (the egress guard denies private by default). **On-prem /
  internal-target connectors are a near-term roadmap item — the LATAM market barely uses cloud, so
  on-prem is a real priority** (documented in ADR-0054; the guard already has the allowlist seam).
- **Scope:** v1 manual steps = typed input + STATIC suggestions; role/team/manager/AD = a FUTURE
  model-first ADR (NOT this engine); re-certification = re-run + report; n8n only as a `webhook_out`
  target, never embedded.
- **CTO-defaulted (not escalated):** transactional outbox; a dedicated least-privilege engine
  ServiceAccount.
- **Dropped:** ADR-0052 (Settings/Notifications/SMTP branch) — the CEO discarded it. Consequence: the
  engine brings its OWN encrypted credential store (AES-256-GCM, `WORKFLOW_SECRET_KEY`) and uses
  polling (no SSE) for run status / manual-task inbox.

## 4. What's DONE

### Phase 0 — COMPLETE, merged to `dev`
| Item | What | To `dev` via |
| --- | --- | --- |
| **P0.1** | BullMQ/Valkey + async `.docx` import (sandboxed heap-capped processor) — **SEC-002 CLOSED** | PR #252 |
| ~~P0.2~~ | Settings/Notifications — **DROPPED** | — |
| **P0.3** | `workflow:read/manage/run/task/secrets` in the shared catalog, safe default **ADMIN-only**, new "Automation" pillar + en/es labels | PR #255 |
| **P0.4** | central **egress guard** (`apps/api/src/common/egress/`): parse-not-sniff scheme allowlist, deny private/loopback/link-local/ULA/IMDS (v4+v6, mapped/NAT64/dec-hex-oct), **socket pinning** (DNS-rebind defense), redirect re-validation, deny-private-by-default + allowlist seam. 121 tests. No consumer wired yet. | PR #255 |
| design | `docs/workflow-engine/` (9 docs) + ADR-0053 | PR #252 |

### Phase 1 — IN PROGRESS, merged into `feat/issue-247…` (NOT yet on `dev`)
| Item | What | PR (→ epic branch) |
| --- | --- | --- |
| **1a** | **ADR-0054** + Prisma schema (7 entities: ApplicationWorkflow, WorkflowConnection, WorkflowVersion, WorkflowRun, WorkflowStepRun, ManualTask, WorkflowSecret) + migration `20260608030810_workflow_engine_foundation` (partial-unique + 3 at-most-one-actor CHECKs) + `@lazyit/shared` zod contracts/enums + tests | #256 ✅ merged |
| **1b-A** | **execution primitives**: the `StepHandler` contract (`apps/api/src/workflow-engine/index.ts` is the import surface), `SecretService` (AES-256-GCM, fail-loud at boot, write-only, INV-6), the **logic-less data mapper** (no eval, frozen ctx, prototype-pollution guards, per-destination encoding), and the REST / WEBHOOK_OUT / MANUAL handlers (all via `guardedFetch`, https-only). 48 tests. | #258 ✅ merged |

## 5. What's NEXT

- **1b-B — engine CORE** (the consumer of 1b-A's `StepHandler`): the `WorkflowEngineModule`; the
  AccessGrant **outbox trigger** (PENDING run in the grant tx + after-commit enqueue + sweeper);
  the run **orchestrator / state machine**; the **BullMQ worker** that runs steps via the connector
  registry, pauses on MANUAL (`AWAITING_INPUT` + `ManualTask`) and resumes on completion; the
  multi-grant `LAST_ACTIVE_GRANT` enforcement; the dedicated engine ServiceAccount; and the HTTP
  **endpoints** (workflows/connections/secrets CRUD write-only + run status + manual-task list/complete),
  gated by `workflow:*`. Sequential after 1a/1b-A (it imports their contract).
- **1c — builder UX** (parallelizable against the 1b-B API contract): per-Application "Workflows" tab,
  a form-based step builder, write-only connection/secret entry, the manual-task inbox (polling), the
  run timeline. `can()`-gated.
- **#257 fix — BullMQ/Valkey connection robustness** (disjoint lane; can run in parallel): see §6.
- **Promote** `feat/issue-247…` → `dev` once 1b backend is a coherent slice (CTO-merge on green CI).
- **Before the final epic close:** `rm -rf epic-248-status/`, update the backups runbook to list
  `WORKFLOW_SECRET_KEY` as a third backup linchpin, and write the entity notes under
  `docs/02-domain/entities/`.

## 6. Known issues

- **#257 — BullMQ/Valkey connection floods logs + import hangs when `REDIS_URL` is unset.** Root cause:
  an existing `infra/env/.env.prod` predates `REDIS_URL`, so the api container falls back to
  `redis://localhost:6379` → `ECONNREFUSED` loop at boot (no retry cap, no fail-loud, no log throttle,
  no job stall ⇒ unstoppable + UI hangs). **Operator relief:** add `REDIS_URL=redis://valkey:6379` to
  `infra/env/.env.prod`, recreate the api. **Code fix (task #18):** in `queue.module.ts` log the
  resolved URL (redacted), bounded `retryStrategy` + throttled error log, fail-loud when unreachable,
  `enableOfflineQueue:false` (enqueue fails fast → 503 not a hung 202), + a job stall/timeout. DevOps:
  `REDIS_URL` in the prod env contract + `start.sh` + an upgrade note. Hardens the engine too.

## 7. CTO-review flags carried forward (from the 1a/1b-A agents — none blocking)

- **1a:** `WorkflowConnection ↔ WorkflowSecret` is bidirectional (collapsible to one direction);
  `WorkflowVersion` carries author attribution + CHECK (matches ArticleVersion); no
  `currentVersionId` (active = latest version, avoids a circular FK).
- **1b-A:** `WorkflowSecret` is NOT in `SOFT_DELETABLE_MODELS` (the service filters `deletedAt:null`
  explicitly) — 1b-B may add it to the extension instead. HTTP handlers expose a public `egressOptions`
  test seam (transport/lookup doubles) — could become an injected egress token. BASIC auth stores the
  full `user:password` pair. Correlation capture is a convention (Location header → allowlisted JSON id
  keys); a per-config `responseExtract` selector is a future step-schema enhancement.
  **`WORKFLOW_SECRET_KEY` is a new backup linchpin** (alongside `POSTGRES_PASSWORD` /
  `ZITADEL_MASTERKEY`).
