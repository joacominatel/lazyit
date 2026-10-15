---
title: Architecture — MOC
tags: [moc, architecture]
status: draft
created: 2026-05-25
updated: 2026-10-09
---

# Architecture — Map of Content

How lazyit is built and run.

- [[stack]] — languages, frameworks, runtime and versions (verified against the repo), incl. the
  shipped **Valkey/BullMQ async substrate** ("BullMQ executes, Postgres remembers").
- [[monorepo]] — workspace layout, package boundaries, how `@lazyit/shared` is shared.
- [[shared-package]] — the contract for what may live in `@lazyit/shared`.
- [[deployment]] — self-hosting target and topology (Caddy + Postgres + **Valkey** on a single
  Compose host; no bundled IdP — local accounts or your own OIDC IdP).
- **Search (Meilisearch)** — the cross-cutting full-text search engine, documented in [[stack]] +
  [[deployment]] (the `meilisearch` Compose service). Decision of record:
  [[0035-search-architecture]].
- **Async substrate & the Applications Workflow Engine** — the shipped **BullMQ-on-Valkey**
  background-job substrate (the async `.docx` import + the per-application provisioning engine).
  Architecture touchpoints: [[stack]] (the "Async workers & queue" section) + [[deployment]];
  decisions [[0053-async-workers-bullmq-valkey]] + [[0054-applications-workflow-engine]]; full
  design vault [[workflow-engine/_MOC|Workflow Engine]].
- [[auth-zitadel-sot]] — **superseded**, kept as history: the Zitadel source-of-truth (Option B) design
  dossier (adapter seam, Management-API write-back, zero-touch bootstrap). The bundled Zitadel was removed
  by [[03-decisions/0102-remove-bundled-zitadel]]; current auth lives in [[deployment]] and
  [[03-decisions/0086-local-authentication-mode]].
- [[authorization]] — the **authZ** architecture: the `@RequirePermission` single-guard model,
  DB-first permission resolution, the catalog-as-code, and the two principal kinds (human [[user]] +
  non-human [[service-account]]). Decisions of record: [[03-decisions/0046-roles-permissions-v2]] +
  [[03-decisions/0048-service-accounts]].

Decisions behind these choices live in [[03-decisions/_MOC|Decisions]].
