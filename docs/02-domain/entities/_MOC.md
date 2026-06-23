---
title: Entities — MOC
tags: [moc, domain]
status: draft
created: 2026-05-25
updated: 2026-06-23
---

# Entities — Map of Content

> [!info] Purpose & fields
> Each note describes an entity's **purpose, relationships and business rules** — and, once the
> model lands in Prisma, a **Fields/Columns** section mirroring the schema (~36 notes now carry
> one). Field-level schemas are documented only for entities that exist in `schema.prisma`;
> not-yet-implemented (⚪) entities stay conceptual until they land, to avoid doc↔schema drift.

| Status legend | |
| --- | --- |
| 🟢 implemented | Exists in `schema.prisma` |
| 🟡 next | Next up in implementation order |
| ⚪ planned | Documented, not yet implemented |

## Assets (core)

- 🟢 [[asset]] — the first-class citizen; a tracked physical/logical thing.
- 🟢 [[asset-model]] — generic make/model/specs an asset is an instance of.
- 🟢 [[asset-category]] — classification of models (laptop, switch, server…).
- 🟢 [[location]] — where an asset physically lives.
- 🟢 [[asset-assignment]] — join entity: who owns an asset, with history.
- 🟢 [[asset-history]] — append-only log of asset state changes.
- 🟢 [[asset-tag-scheme]] — singleton instance-config: opt-in auto-tag scheme (monotonic counter, gaps accepted). [[0063-configurable-asset-tag-scheme]] · [[0068-asset-tag-existing-estate-awareness]]

## People

- 🟢 [[user]] — central to access, peripheral to assets (role + DB-first permissions).
- 🟢 [[user-history]] — append-only log of user lifecycle events. [[0050-user-history-and-activity-user-entity]]

## Auth / AuthZ

- 🟢 [[role-permission]] — the editable role → permission map (the DB-first authZ source). [[0046-roles-permissions-v2]]
- 🟢 [[permission-audit-log]] — append-only trail of role-matrix edits. [[0046-roles-permissions-v2]]
- 🟢 [[service-account]] — a non-human principal (lazyit-native token + direct grants). [[0048-service-accounts]]
- 🟢 [[service-account-permission]] — a service account's direct permission grants. [[0048-service-accounts]]
- 🟢 [[service-account-audit-log]] — append-only trail of service-account lifecycle. [[0048-service-accounts]]

## Access

- 🟢 [[application]] — a SaaS, internal app or service access is granted on.
- 🟢 [[application-category]] — user-managed grouping of applications.
- 🟢 [[access-grant]] — a user's access to an application, with grant/revoke history.
- ⚪ [[access-request]] — approval workflow; **deferred** by [[0023-access-management-design]].

## Workflow engine (Access automation)

The opt-in, per-application engine that provisions / deprovisions a user in an external system when
access changes — fired **after** the [[access-grant]] commits, decoupled (the inverse of INV-5). See
[[0054-applications-workflow-engine]] · [[0053-async-workers-bullmq-valkey]] · epic #248.

- 🟢 [[application-workflow]] — the opt-in `(application, trigger)` binding; soft-delete.
- 🟢 [[workflow-connection]] — the per-app connector instance (REST | WEBHOOK_OUT | MANUAL); soft-delete.
- 🟢 [[workflow-version]] — the immutable, append-only definition snapshot (the error-handling DAG).
- 🟢 [[workflow-run]] — the execution ledger, one row per fired grant event (idempotent, append-only).
- 🟢 [[workflow-step-run]] — append-only, one row per step attempt.
- 🟢 [[manual-task]] — the human-in-the-loop pause (`AWAITING_INPUT`); statuses, no soft-delete.
- 🟢 [[workflow-secret]] — the engine's own AES-256-GCM, write-only credential store; soft-delete.

## Consumables

- 🟢 [[consumable-category]] — user-managed grouping of consumable types.
- 🟢 [[consumable]] — stock-counted item (cables, mice, toner…).
- 🟢 [[consumable-movement]] — stock in/out movement.

## Knowledge Base

- 🟢 [[article]] — knowledge-base document (markdown); simple wiki.
- 🟢 [[article-category]] — user-managed grouping of articles.
- 🟢 [[article-version]] — append-only historical version of an article ([[0042-article-versioning-and-linking]]).
- 🟢 [[article-link]] — links an article to an asset or application ([[0042-article-versioning-and-linking]]).
- 🟢 [[folder]] — the flat [[article-category]] evolved: a self-referential hierarchy (`parentId`) that is an article's **one home folder**; live-only partial-unique name within a parent. [[0059-kb-folders-links-and-import]]
- 🟢 [[article-alias]] — a nav-only symlink to an article living elsewhere (`createdAt`-only, hard-delete; never widens access). [[0059-kb-folders-links-and-import]]
- 🟢 [[article-wiki-link]] — a materialized article↔article `[[slug]]` edge computed on save (powers backlinks + fast resolution; hard-rebuilt). [[0059-kb-folders-links-and-import]]

## Dashboard (derived)

- 🟢 [[recent-activity]] — read-only DB **view** unifying asset/access/stock/user activity into one feed.

## Notifications (operational nudges)

The curated, ADMIN-only bell — distinct from the [[recent-activity]] view (which can't address a row).
See [[0056-in-app-notification-bell]] · issue #313.

- 🟢 [[notification]] — append-only event store of curated nudges (fan-out-on-read).
- 🟢 [[notification#NotificationRead]] — per-user read join for targeted and broadcast notifications (documented inline in [[notification]]).

## Secret Manager

Zero-knowledge vaults living beside the Knowledge Base — the server never holds a key that decrypts a
secret **value** (a sharp exception to INV-8 ADMIN-omnipotence; proposes INV-10). A per-user keypair
envelope wraps a per-vault DEK to each member; capability `secret:read`/`secret:manage` lets you *enter*,
a wrapped DEK lets you *decrypt*. Distinct from the server-decryptable [[workflow-secret]]. See
[[0061-secret-manager-zero-knowledge]] · issue #366.

- 🟢 [[secret-vault]] — a folder vault = the crypto boundary; server-visible name + members, a random DEK never stored in clear. [[0061-secret-manager-zero-knowledge]]
- 🟢 [[secret-item]] — a secret value inside a vault; stores only ciphertext/iv/authTag/keyVersion under the vault DEK. [[0061-secret-manager-zero-knowledge]]
- 🟢 [[vault-membership]] — a crypto member of a vault; the row carries the DEK wrapped to the member's public key (soft-revoke v1 = drop the row). [[0061-secret-manager-zero-knowledge]]
- 🟢 [[user-keypair]] — one keypair per User; public key in clear + private key wrapped under Argon2id(password) and again under the recovery key. [[0061-secret-manager-zero-knowledge]]
- 🟢 [[secret-audit-log]] — append-only trail of secret-manager operations (vault create/delete, member add/remove, item write). [[0061-secret-manager-zero-knowledge]]

## Migrator (bulk import)

The guided bulk-import slice — an upload becomes a reviewable session of typed rows, committed in
one auditable run. See [[0069-migrator-import]] · issue #639.

- 🟢 [[import-session]] — the transient, owner-scoped wizard session (upload → parse → map → dry-run → commit); TTL-GC'd, hard-deleted. [[0069-migrator-import]]
- 🟢 [[import-row]] — one parsed-and-coerced source row within a session (status + per-row error); transient scratch, hard-deleted with its session. [[0069-migrator-import]]
- 🟢 [[import-run]] — append-only audit ledger of a commit (actor, target, final counts, file hash); the durable record, never deleted. [[0069-migrator-import]]

Model overview & order: [[02-domain/_MOC|Domain]]. Conventions: [[conventions]].
