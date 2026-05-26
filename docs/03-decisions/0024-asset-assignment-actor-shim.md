---
title: "ADR-0024: Retrofit AssetAssignment actor to the X-User-Id shim"
tags: [adr]
status: accepted
created: 2026-05-25
updated: 2026-05-26
deciders: [Joaquín Minatel]
---

# ADR-0024: Retrofit AssetAssignment actor to the X-User-Id shim

## Status

accepted — 2026-05-25. **Supersedes in part** [[0019-asset-assignment-integrity]] (only its
*actor source*, decision bullet 2 — everything else there stands) and **closes** the "retrofit
AssetAssignment to the `X-User-Id` shim" follow-up of [[0023-access-management-design]]. Builds on
[[0022-draft-visibility-auth-shim]].

## Context

[[asset-assignment]] records *who acted* in two optional audit FKs: `assignedById` (on open) and
`releasedById` (on release). It predates the `X-User-Id` shim, so it took those ids from the
**request body** (`CreateAssetAssignmentSchema.assignedById`,
`ReleaseAssetAssignmentSchema.releasedById`). That was flagged as a divergence the moment
[[0023-access-management-design]] established the shim as *the* way to record an actor: the newer
[[access-grant]] takes `grantedById` / `revokedById` from the optional `X-User-Id` header
(validated, header-only), never the body. ADR-0023 explicitly logged the convergence as a
follow-up, and the security sweep tracked the body-based actor as DEF-005 (`docs/06-security`).

A client-supplied actor in the body is trivially spoofable and fragments "who acted" between body
and header. With two append-only joins now in the codebase, having them disagree on so basic a
thing is avoidable inconsistency.

## Decision

Converge AssetAssignment onto the **exact** AccessGrant actor pattern
([[0022-draft-visibility-auth-shim]], [[0023-access-management-design]]):

- **`POST /asset-assignments`** sets `assignedById` from the optional `X-User-Id` header; the body
  no longer accepts `assignedById`.
- **`PATCH /asset-assignments/:id/release`** sets `releasedById` from the header; its body carries
  **only `{ notes? }`**.
- **`PATCH /asset-assignments/:id/notes`** is unchanged — a metadata edit with no actor.
- **Actor validation (shared with AccessGrant):** an absent/empty header → `null` actor
  (system/unknown), allowed by the `SetNull`/optional design. A **present** header must be a
  well-formed UUID *and* reference a **live (non-soft-deleted)** user, else `400` — a soft-deleted
  user cannot act as an actor (the `deletedAt: null` filter enforces this). The id is never
  silently dropped.

The audit FKs themselves (`assignedById` / `releasedById`, `onDelete: SetNull`, optional) and the
response shape (`AssetAssignmentSchema` still exposes both, nullable) are **unchanged** — this is
purely about *where the write reads the actor from*.

> [!warning] Breaking change to the API contract — acceptable now
> Removing `assignedById` / `releasedById` from the request bodies is a **breaking contract
> change**. It is safe to make now because there are **no external clients**: the agent-B web app
> does not consume the assignment write endpoints yet. Doing it before any client couples to the
> old shape avoids a future migration.

## Consequences

- **Positive:** one actor model across both append-only joins ([[asset-assignment]],
  [[access-grant]]); the actor is trustworthy (header → JWT later, never the client body) and
  forward-compatible with real auth ([[0016-auth-strategy-deferred]]); DEF-005 is resolved.
- **Still insecure until auth lands:** the `X-User-Id` header is spoofable
  ([[0022-draft-visibility-auth-shim]] security note). No authorization on reads or writes yet —
  anyone can assign/release. Acceptable only for the pre-auth MVP, same posture as AccessGrant.
- **Minor duplication:** `resolveActor` + the UUID regex now exist in both
  `asset-assignments.service.ts` and `access-grants.service.ts`. Extracting a shared
  actor-resolution helper is a **future refactor candidate** once a third caller appears — not done
  now to avoid a premature, cross-cutting abstraction.
  > [!done] Resolved — 2026-05-26 (issue #17)
  > The third caller arrived with AssetHistory ([[0033-asset-history-event-model]]), so the resolver
  > was extracted to a shared `ActorService` (`apps/api/src/common/actor.service.ts`, `@Global`).
  > `AssetAssignment`, `Asset` and `Consumable` adopted it then; **`AccessGrant` and `Article`** (the
  > latter's `resolveCurrentUser`) were migrated onto it in issue #17. `ActorService` is now the
  > single actor/identity resolver — no inline `resolveActor`/`UUID_REGEX` copies remain.

## Related

[[asset-assignment]] · [[access-grant]] · [[user]] · [[0019-asset-assignment-integrity]] ·
[[0022-draft-visibility-auth-shim]] · [[0023-access-management-design]] ·
[[0016-auth-strategy-deferred]] · [[0018-api-documentation-swagger]]
