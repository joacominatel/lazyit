---
title: "ADR-0073: Infra node → secret linkage (soft handle-refs, member-scoped attach)"
tags: [adr, infra, topology, secrets, security, authz]
status: accepted
created: 2026-06-27
updated: 2026-06-27
deciders: [Joaquín Minatel]
---

# ADR-0073: Infra node → secret linkage (soft handle-refs, member-scoped attach)

## Status

**accepted** — 2026-06-27. Issue #801. Backend + shared contract + migration shipped; the frontend
attach/detach UI builds against the contract on the same branch. Implements the asset→secret linkage
deferred by [[0070-infra-topology-graph]] §5/§6 (the drill-in `secretRefs` placeholder).

## Context

The infra topology drill-in ([[0070-infra-topology-graph]] §6) already ships a frozen `secretRefs`
shape on `InfraNodeDetail` — secret **HANDLES only**, never values (INV-10,
[[0061-secret-manager-zero-knowledge]]). But v1 had **no data-model linkage** between a node and a
secret, so `getNodeDetail` hard-coded `secretRefs: []`. Operators want to pin "this node uses *these*
secrets" — the SSH key for a host, the DB root password for a database VM — surfaced on the panel,
one click from the value (in the Secret Manager) without leaving the map.

Constraints that shaped the decision:

- **INV-10 is absolute.** The server is a ciphertext custodian; it must never store, resolve, or
  return a value, envelope, IV, auth tag, or wrapped key. A linkage surface must carry **metadata
  only** (handle, label, vaultId) and never approach the value side. The
  `secret-manager/inv-10.guard.spec.ts` merge-gate must keep passing.
- **No `Secret` model exists.** The value entity is `SecretItem` (table `secret_items`) under a
  `SecretVault`, with per-vault crypto `VaultMembership`. A secret's identifier is its **`handle`** —
  **editable** and only **live-unique** (a partial unique index over non-deleted rows).
- **Established soft-ref convention.** The KB chip (`{{ lazyit_secret.HANDLE }}`) and
  `SecretAuditLog` both reference secrets by **plain handle string, no FK**. The linkage should follow
  the same posture, not invent a new one.
- **Two-layer authz** ([[0061-secret-manager-zero-knowledge]] §7). RBAC capability (`secret:read` /
  `secret:manage`) is orthogonal to per-vault crypto **membership**; holding a capability grants no
  vault access without a live `VaultMembership`.

## Decision

### 1. A soft handle-ref join table — `InfraNodeSecretRef` (no FK to the secret)

A new `InfraNodeSecretRef` row stores `{ nodeId, vaultId, handle, createdAt }` with
`@@unique([nodeId, vaultId, handle])` and `@@index([nodeId])`. It has a real FK to `InfraNode`
(`onDelete: Cascade` — the link is meaningless without its node) but **NO FK to `SecretItem`**:
`handle` + `vaultId` are stored as soft metadata, mirroring the KB chip + `SecretAuditLog` convention.
It is **not soft-deletable** (a topology edit, not audited domain data) — detach hard-deletes the row.
`handle`/`vaultId` are **metadata only — never a value** (INV-10).

**Rename-drift trade-off (accepted).** Because `handle` is editable and only live-unique, a ref can
drift if the secret is renamed. Rather than chase renames (there is no FK to cascade), the linkage is
**resolved at read** against live `secret_items` and a ref that no longer matches a live secret
(soft-deleted, or its handle renamed away) is **dropped** — never a dangling chip. This is the exact
posture the KB chips and `SecretAuditLog` already accept; consistency beats a rename-tracking
mechanism nobody asked for.

### 2. Read resolution — metadata-only, dangling-drop, member-blind

`getNodeDetail` loads the node's `InfraNodeSecretRef` rows and batch-resolves them via a new
`SecretManagerService.resolveHandlesMetadata(refs)` that queries live `secret_items` selecting **only
`{ handle, label, vaultId }`** (NO crypto columns) and returns them **stable-sorted (label, then
handle)**. Refs with no live match are dropped. Resolution is **member-blind**: handle + label are
metadata shown to any node viewer (the same posture as a KB chip), so the read does not gate on the
viewer's vault membership — the value side stays unreachable regardless of who looks.

### 3. Attach authz — member-scoped (the value-adjacent action)

Attaching a handle is the one action that **references a specific secret**, so it carries the stricter
gate. `SecretManagerService.assertHandleAttachable(principal, vaultId, handle)` enforces, in order:

1. a **LIVE `VaultMembership`** of `vaultId` for the caller → else **403** (Forbidden);
2. a **live `SecretItem`** with that `handle` **in that vault** → else **404** (Not Found).

Membership is checked **first** so a non-member can never probe whether a handle exists in a vault
they cannot see (no information leak). The check is metadata-only — it confirms existence by selecting
`id`; it never reads an envelope. Attach upserts the join row **idempotently** on the
`(nodeId, vaultId, handle)` unique (re-attaching is a no-op, **not** a 409) and returns the node's
updated resolved `secretRefs`.

### 4. Detach authz — topology edit only

Detaching is a topology edit that touches no secret, so it needs **no vault membership** — only the
route permission. It hard-deletes the matching join row and is **idempotent** (`deleteMany`; deleting
a missing ref is a no-op), returning the updated resolved `secretRefs`.

### 5. Discrete attach/detach endpoints (not a whole-array PATCH)

Unlike the node's `shortcuts` (a whole-array replace on the node PATCH), secret links get **discrete**
`POST` / `DELETE /infra/nodes/:id/secrets` endpoints. A whole-array replace would force the API to
re-authorize every element on every edit and can't express per-element membership outcomes cleanly;
discrete attach/detach maps one action to one authz decision. Both take `AttachInfraSecret`
(`{ handle, vaultId }`) in the **body** — `handle` can contain dots, so it is not a path segment.

- `POST /infra/nodes/:id/secrets` — `@RequirePermission('infra:manage', 'secret:read')` (layer-1, AND)
  + `HumanOnlyGuard` (it references a secret — matches the Secret Manager's human-only posture); the
  layer-2 live-membership check is enforced in the service. Returns `InfraSecretRef[]`.
- `DELETE /infra/nodes/:id/secrets` — `@RequirePermission('infra:manage')`; no extra guard (follows
  infra's existing posture — a plain topology mutation). Returns `InfraSecretRef[]`.

### 6. Contract (`@lazyit/shared`)

`AttachInfraSecretSchema = z.strictObject({ handle: z.string().trim().min(1).max(80), vaultId:
z.cuid() })` (+ inferred `AttachInfraSecret`). Detach reuses the same shape. The frozen
`InfraSecretRefSchema = { handle, label, vaultId }` is **unchanged**; only its (and
`InfraNodeDetail.secretRefs`') doc prose was updated from "empty in v1" to "resolved from links".

## Consequences

**Positive**

- The drill-in's `secretRefs` is real, with **zero contract change** to the frozen `InfraSecretRef`
  shape — the frontend panel needed only the new attach/detach calls.
- INV-10 is preserved by construction: the new `SecretManagerService` methods select metadata columns
  only and import no crypto; the merge-gate spec still passes. No FK to `SecretItem` means the linkage
  can never become a join path to a value.
- Authz reuses the Secret Manager's existing membership primitives — no parallel authz logic.

**Negative / trade-offs**

- **Rename drift** — a renamed secret's link silently drops on the next read (accepted, §1;
  consistent with KB chips + `SecretAuditLog`). Re-attach to restore.
- **Member-blind labels** — a node viewer who is not a vault member still sees the handle + label
  (metadata only). This matches the KB-chip posture; the value remains unreachable.
- **Two more endpoints** vs a whole-array shortcut — justified by per-vault member-scoped authz (§5).

## Honoured invariants / related ADRs

- **INV-10** / [[0061-secret-manager-zero-knowledge]] — metadata only, never a value; merge-gate kept
  green; no crypto imported into the new code.
- [[0070-infra-topology-graph]] §5/§6 — implements the deferred node→secret linkage behind the
  pre-frozen `secretRefs` shape.
- [[0046-roles-permissions-v2]] — `infra:manage` + `secret:read` layer-1 gate (AND semantics).
- [[0005-id-strategy]] (`cuid()`) / [[0006-soft-delete-and-auditing]] (a non-soft-deletable
  current-state join, like `VaultMembership`).

## Alternatives considered

- **A real FK to `SecretItem`** — rejected: it would create a join path toward the value entity
  (INV-10 risk), break the KB-chip/`SecretAuditLog` soft-ref convention, and couple a topology edit to
  the secret lifecycle. Soft handle-refs + read-time resolution is the established, lazier pattern.
- **Rename-tracking (cascade handle updates)** — rejected: no FK to cascade, and the drift-drop
  behaviour is already the accepted norm elsewhere. Not worth a mechanism.
- **Member-scoped read resolution** — rejected for v1: handle + label are metadata shown to any node
  viewer (KB-chip parity); gating the read adds per-viewer cost for no value-side protection.
- **A whole-array PATCH on the node (like `shortcuts`)** — rejected: can't express per-element
  membership authz cleanly and re-authorizes the whole set on every edit (§5).
- **Attach without membership (RBAC-only)** — rejected: attach references a specific secret; a caller
  who can't read the vault must not be able to pin its handle. Live membership is the right gate.
</content>
</invoke>
