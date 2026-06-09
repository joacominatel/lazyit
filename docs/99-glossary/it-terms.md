---
title: IT Terms
tags: [glossary]
status: draft
created: 2026-05-25
updated: 2026-06-08
---

# IT Terms

General IT/operations vocabulary. For lazyit's own domain objects, see
[[entities/_MOC|Entities]].

| Term | Meaning in lazyit's context |
| --- | --- |
| **Asset** | A tracked, individual thing the IT team owns ([[asset]]). Contrast with a consumable. |
| **Consumable** | A stock-counted item, not tracked individually ([[consumable]]). |
| **Access grant** | A user's active access to an application ([[access-grant]]). |
| **Access request** | A pending, approval-gated request for access ([[access-request]]). |
| **Provisioning** | Setting up access/hardware for a user (e.g. on onboarding). |
| **Deprovisioning / offboarding** | Revoking access and reclaiming assets when someone leaves. |
| **SLA** | Service Level Agreement — target response/resolution times for tickets. |
| **Runbook** | A step-by-step operational procedure (for operating lazyit; see [[05-runbooks/_MOC|Runbooks]]). |
| **CMDB** | Configuration Management Database — the inventory of assets and their relationships; lazyit's asset model plays this role. |
| **AD / LDAP** | Active Directory / directory service; an AD group is a kind of [[application]] you can grant access to. |
| **jsonb** | PostgreSQL binary JSON type; used for flexible asset `specs` ([[0007-flexible-asset-specs-jsonb]]). |
| **Soft delete** | Marking a row deleted (`deletedAt`) without removing it, for auditability ([[0006-soft-delete-and-auditing]]). |
| **Append-only** | A table whose rows are only ever inserted, never updated/deleted (history, ledgers). |

> [!note] Grow this as terms come up in tickets, ADRs and runbooks. Keep definitions
> lazyit-specific, not generic dictionary entries.

## Workflow engine vocabulary

Terms for the [[0054-applications-workflow-engine|Applications Workflow Engine]] (shipped) — the
opt-in, per-application provisioning automation on the Access pillar. Entity terms carry a one-line
gloss and link to their note in [[entities/_MOC|Entities]]; the design depth lives in the
[[workflow-engine/_MOC|Workflow Engine vault]].

| Term | Meaning in lazyit's context |
| --- | --- |
| **Applications Workflow Engine** | The opt-in, admin-configurable engine that automates provisioning/deprovisioning in external systems (Jira, Redmine, any REST/webhook target) when access is granted/revoked in lazyit. An app with **no** workflow behaves exactly as before — granting access just records the [[access-grant]] ([[0054-applications-workflow-engine]]). |
| **Workflow** ([[application-workflow]]) | A per-`Application` configuration binding a trigger (`ACCESS_GRANTED` / `ACCESS_REVOKED`) to a versioned DAG of steps. Opt-in; one per app. |
| **Workflow Connection** ([[workflow-connection]]) | A reusable, named external target + credential a step calls (base URL + auth, e.g. a Jira instance). Entered write-only; secrets are never read back. |
| **Workflow Run** ([[workflow-run]]) | One execution of a workflow for a single trigger event. Doubles as the transactional-outbox row and pins the engine ServiceAccount for that run. |
| **Workflow Step Run** ([[workflow-step-run]]) | The append-only execution record of a single step within a run (status, attempts, result) — the data behind the run timeline. |
| **Manual Task** ([[manual-task]]) | A `MANUAL` step (a *human task*) that pauses the run as DB state until a person completes it from the inbox. A provisioning queue, **not** a generic ticketing/approval system. |
| **Workflow Secret** ([[workflow-secret]]) | An AES-256-GCM-encrypted, write-only credential bound to a connection; never returned by the API. The store fails loud at boot without `WORKFLOW_SECRET_KEY`. |
| **Opinionated error-handling DAG** | The workflow shape: typed steps (`REST` / `WEBHOOK_OUT` / `MANUAL`) wired by first-class success/failure edges, each with per-step success criteria + retries — **not** a free-form n8n-style canvas. |
| **Transactional outbox** | The decoupling pattern: the engine fires only *after* the access-grant transaction commits, so a failing external call never blocks or rolls back the grant — the deliberate inverse of the Zitadel write-back. |
| **Deprovision policy** | Per-workflow rule for when an `ACCESS_REVOKED` trigger actually deprovisions, since a user may hold several active grants on one app. Default `LAST_ACTIVE_GRANT` (fire only when the *last* active grant is revoked); `EACH_GRANT` fires on every revoke ([[application-workflow]]). |
| **BullMQ** | The Redis-protocol job/queue library that executes workflow steps and async jobs: "BullMQ executes; PostgreSQL remembers". Runs **sandboxed processors** for memory-heavy/untrusted jobs ([[0053-async-workers-bullmq-valkey]]). |
| **Valkey** | The self-hosted, Redis-compatible (BSD fork) datastore backing BullMQ. Internal-network-only container with AOF persistence; reached via `REDIS_URL` ([[0053-async-workers-bullmq-valkey]]). |
| **Egress guard** | The anti-SSRF outbound-HTTP guard for workflow calls: denies private/loopback/IMDS ranges, pins the resolved socket, re-validates on redirect, https-only ([[0054-applications-workflow-engine]]). |
| **Data mapper** | The logic-less (no `eval`) mapping that shapes a step's request payload from prior-step output / run context — declarative field mapping, never arbitrary code. |
| **Dry-run** | A builder action that previews a step's resolved request payload with **no** side effects (no external call). |
| **Test connection** | A builder action that verifies a Workflow Connection's reachability and credentials before a workflow uses it. |

> [!note] These mirror the [[entities/_MOC|entity notes]] and ADR-0053/0054; keep the
> glosses short and point at the entity note / ADR for depth rather than restating it here.
