---
title: "ADR-0023: Access management design (Application + AccessGrant)"
tags: [adr]
status: accepted
created: 2026-05-25
updated: 2026-05-25
deciders: [Joaquín Minatel]
---

# ADR-0023: Access management design (Application + AccessGrant)

## Status

accepted — 2026-05-25. Third pillar of the MVP backend (after assets and the knowledge base). It
mirrors the lifecycle-join pattern of [[0019-asset-assignment-integrity]], builds on
[[0006-soft-delete-and-auditing]] and [[0005-id-strategy]], and adopts the `X-User-Id` shim from
[[0022-draft-visibility-auth-shim]] for the "who acted" fields.

## Context

The third domain area is **access management**: tracking *who can access what* across SaaS products
(Jira, GitHub, AWS), internal systems, and technical services (VPN, AD groups). Three entities:

- **[[application]]** — the catalog of things access is granted on.
- **ApplicationCategory** — a user-managed grouping of applications.
- **[[access-grant]]** — the [[user]] ↔ [[application]] join that answers "who can access what?",
  and (critically for offboarding) records *revocation* auditably.

The earlier domain notes sketched `Application` with a hardcoded `type` enum
(SaaS / internal / AD-group / service) and per-application **approvers** feeding an
[[access-request]] approval workflow. Implementing the area for real forces several concrete
choices those sketches left open — and a reconsideration of that prior design.

## Considered options

**(1) Classifying an Application — hardcoded `type` enum vs user-managed category:**

- **`type` enum** — ❌ the same rigidity already rejected for assets and articles. The "kinds of
  apps" an IT team tracks vary by org, and adding one would need a migration.
- **User-managed `ApplicationCategory`** (FK, `onDelete: SetNull`) — ✅ consistent with
  [[asset-category]] / [[article-category]]; editable from the app; ships with a seed set.

**(2) AccessGrant lifecycle & uniqueness:**

- **Soft delete (`deletedAt`)** — ❌ revocation is a *lifecycle* event, not a deletion. Mirrors
  [[asset-assignment]]'s `releasedAt` ([[0006-soft-delete-and-auditing]]).
- **Append-only with `revokedAt`** (`null` = active) — ✅ auditable grant/revoke trail for
  offboarding.
- **Uniqueness** — a partial unique index like AssetAssignment's "one active per (asset, user)"
  would be **wrong here**: multi-grant is a *feature*. The same user may hold several active grants
  on one application at different `accessLevel`s (e.g. `admin` on the console + `readonly` on the
  API). → **no uniqueness constraint.**

**(3) `accessLevel` — enum vs free-form string:**

- **Enum** — ❌ every application defines its own levels (`admin`, `developer`, `viewer`, `owner`,
  `billing`…). Modeling them centrally is futile and needs a migration per app.
- **Free-form optional string** — ✅ each [[application]] owns its vocabulary; lazyit stores it
  verbatim and never interprets it.

**(4) Recording the actor (`grantedById` / `revokedById`):**

- **Body fields, like AssetAssignment** (`assignedById` / `releasedById`) — ❌ trusts a
  client-supplied actor id, and fragments "who acted" between body and header now that
  [[0022-draft-visibility-auth-shim]] established the `X-User-Id` shim as *the* authenticated actor.
- **`X-User-Id` shim (optional), like Article authorship** — ✅ the actor comes from the caller
  header (a JWT later), never the body. **Optional** because `grantedById` / `revokedById` are
  `SetNull` by design — a "system" actor (an import, a future scheduler) leaves them `null`.

**(5) Approval workflow & expiry auto-revoke — build now or defer:** building an approval pipeline
and an expiry scheduler now would balloon the scope of an MVP whose grants are, today, created
directly by the IT team.

## Decision

- **Application**: a user-managed `ApplicationCategory` (FK optional, `onDelete: SetNull` — deleting
  a category detaches its apps, like [[asset-model]] → [[asset-category]]; **no 409 guard**, unlike
  [[article-category]] whose FK is `Restrict`). Fields: `name`, `description?`, `url?`, `vendor?`,
  `categoryId?`, `isCritical` (default `false`), `metadata?` (jsonb), `notes?`; soft delete +
  timestamps.
- **AccessGrant**: append-only join — `userId` + `applicationId` (both required,
  `onDelete: Restrict`), `accessLevel?` (free-form), `grantedAt` (`@default(now())`), `revokedAt?`
  (`null` = active), `expiresAt?` (informative), `grantedById?` / `revokedById?`
  (`onDelete: SetNull`), `notes?`. `createdAt` / `updatedAt`, **no `deletedAt`, no `DELETE`
  endpoint**. **No uniqueness constraint** — multi-grant is allowed. Identity (`userId`,
  `applicationId`, `grantedAt`) is immutable; only `notes`, `revokedAt` and `expiresAt` are mutable.
- **`accessLevel`**: optional free-form string, owned by each application.
- **Actor via the `X-User-Id` shim (optional)** ([[0022-draft-visibility-auth-shim]]): `POST
  /access-grants` sets `grantedById` from the header; `PATCH /:id/revoke` sets `revokedById` from
  the header and its body carries only `{ notes? }`; `PATCH /:id/notes` and `PATCH /:id/expiry` are
  metadata edits with **no** actor. An absent header → `null` actor (system/unknown), allowed by the
  optional/`SetNull` design.
- **Create-time integrity**: granting requires `userId` **and** `applicationId` to reference **live**
  (non-soft-deleted) rows → `400` otherwise (mirrors [[article]]'s category check). Prevents granting
  access to a decommissioned app or a departed user. The FK `Restrict` is only a hard-delete safety
  net — soft delete bypasses it (same nuance as [[0019-asset-assignment-integrity]]).
- **Prior design discarded**: the `type` enum and per-application **approvers** from the old
  [[application]] note are dropped. Approver logic belongs to the access-request workflow, which is
  deferred below.

## Consequences

- **Positive:** access is auditable (grant/revoke history survives offboarding); multi-grant models
  real-world layered access; categories stay flexible; the actor is trustworthy (header → JWT, never
  the client body) and forward-compatible with real auth ([[0016-auth-strategy-deferred]],
  [[0022-draft-visibility-auth-shim]]).
- **Soft vs hard delete (same caveat as [[0019-asset-assignment-integrity]]):** `DELETE
  /applications/:id` and `DELETE /users/:id` are **soft** (`UPDATE deletedAt`), so `Restrict` does
  **not** fire — a grant can end up pointing at a soft-deleted app/user. The create-time live-check
  reduces but doesn't eliminate this (an app may be soft-deleted *after* grants exist). A
  soft-delete-time guard could be added later.
- **Insecure until auth lands:** the `X-User-Id` header is spoofable
  ([[0022-draft-visibility-auth-shim]] security note). There is no authorization on reads or writes
  yet — anyone can grant/revoke. This is acceptable only for the pre-auth MVP.

## Deferred (explicit)

- **[[access-request]]** — the approval workflow (`requested → approved / rejected → provisioned`)
  and the **approver** concept. Grants are created directly for now; a real workflow gets its own
  design later (and likely revives approvers). The entity note stays ⚪ planned.
- **Auto-revoke on `expiresAt`** — `expiresAt` is **informative only**; no scheduler mutates data.
  The list endpoints accept an optional `includeExpired=false` to *hide* past-expiry active grants,
  but nothing is changed in the database. A worker that auto-revokes is a future decision (note the
  BullMQ/Redis tension in [[0009-bun-first-vs-app-stack]]).
- **`Application.metadata` validation** — unvalidated jsonb, the same debt as `Asset.specs` /
  `Article.metadata` ([[0007-flexible-asset-specs-jsonb]]).

## Follow-ups

- ✅ **Retrofit [[asset-assignment]] to the `X-User-Id` shim** — **done** in
  [[0024-asset-assignment-actor-shim]] (2026-05-25). AssetAssignment originally took `assignedById` /
  `releasedById` from the request **body** because it predated the shim; ADR-0024 moved both to the
  optional `X-User-Id` header (header → JWT later), converging the "who acted" model across both
  append-only joins. The two no longer differ.
- AccessRequest approval workflow; expiry auto-revoke scheduler; a soft-delete-time guard on
  apps/users with active grants; `metadata` validation.

Related: [[application]] · [[access-grant]] · [[access-request]] · [[user]] ·
[[0019-asset-assignment-integrity]] · [[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] ·
[[0007-flexible-asset-specs-jsonb]] · [[0016-auth-strategy-deferred]] ·
[[0022-draft-visibility-auth-shim]] · [[prisma-migrations]]
