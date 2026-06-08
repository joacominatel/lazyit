---
title: "Workflow Engine — Map of Content"
tags: [workflow-engine, moc, index, access]
status: draft
created: 2026-06-07
updated: 2026-06-07
---

# Workflow Engine — Map of Content

> Design vault for the **Applications Workflow Engine** — an opt-in, admin-configurable
> provisioning/deprovisioning engine on the **Access pillar**. When IT grants or revokes access to
> an `Application` inside lazyit, an optional per-app workflow automates the change in the external
> system. No workflow configured ⇒ access is recorded exactly as today
> ([[0023-access-management|ADR-0023]]).
>
> **Start here:** read [[_synthesis]] first — it is the binding architecture; the seven area docs
> below are its depth.

## The synthesis (read first)

- [[_synthesis]] — consolidated architecture: BullMQ-on-Valkey substrate (Postgres is the system of
  record), the data model, connector model, security posture, the phased roadmap, scope guardrails,
  reconciled conflicts, and the open questions for the CEO.

## Area designs

- [[domain-product]] — the entity model & product shape: opt-in extension of the Access pillar;
  config vs immutable definition vs execution ledger; idempotency `(trigger, accessGrantId)`; the
  run-row-as-outbox; human pauses as DB state; the `workflow:*` permission domain.
- [[backend]] — NestJS engine: `WorkflowsModule` + `WorkflowEngineModule`; the per-run state machine
  in Postgres; step-at-a-time re-enqueued jobs; the `StepHandler` registry; saga compensation;
  reuse of `SecretEncryptionService` + notifications + the ServiceAccount actor.
- [[orchestration-substrate]] — "BullMQ executes steps; PostgreSQL remembers everything": the
  substrate decision, `AWAITING_INPUT` + event-driven resume, the transactional outbox, and why
  Temporal/n8n/synchronous are rejected (pg-boss is the documented fallback).
- [[integrations-connectors]] — the three-layer connector model (type / instance / step), the
  declarative vs code-backed tiers, logic-less data mapping over a frozen `ctx`, correlation capture
  for deprovision, and n8n-as-a-target.
- [[devops-infra]] — riding ADR-0053's single Valkey container, the co-located→dedicated worker
  path, host sizing, AOF-vs-rebuildable, SSRF egress mechanics, and bull-board observability.
- [[security]] — the threat model: the egress guard (SSRF), write-only encrypted secrets, no
  arbitrary code in mapping, sandboxed processors, the at-most-one-actor audit ledger, and the
  inbound-webhook contract.
- [[frontend]] — the admin builder UX: per-Application Workflows tab, the **opinionated error-handling
  DAG** builder (boxes wired by first-class success/failure edges, a category-organized step palette,
  per-step success criteria + retry + "on failure →"; a constrained diagram renderer reusing the
  asset-history timeline grammar, no React Flow — NOT a free-form business-condition canvas), write-only
  secret fields, the edge-aware run timeline, and the manual-task inbox on the notification bell/SSE.

## Key referenced decisions

- [[0053-async-workers-bullmq-valkey]] — the substrate (accepted; names this engine as a justifier).
- ADR-0052 — Settings & Notifications (SystemSecret, bell/SSE); on `feat/settings_notifications_smtp`,
  **not yet on `dev`**; numbering collides with the merged `0052` (CI parallel-docker) — renumber on
  merge (see [[_synthesis#Reconciled conflicts]]).
- [[0048-service-accounts]] · [[0046-roles-permissions-v2]] · [[0043-zitadel-source-of-truth]] ·
  [[0035-search-architecture]] · [[0023-access-management]] · [[0007-flexible-asset-specs-jsonb]] ·
  [[0006-soft-delete-and-auditing]] · [[0005-id-strategy]].
