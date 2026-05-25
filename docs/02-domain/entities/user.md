---
title: User
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-05-25
---

# User

> 🟢 implemented · Area: People · Implementation order: 1 (atomic, no dependencies)

## Purpose

A person in the organization. **Central to access, peripheral to assets** ([[asset-centric]]):
users come and go while assets persist, so the model attaches users *to* assets rather than
the reverse.

## Relationships

- **owns** N [[asset]]s via [[asset-assignment]] (with history).
- **holds** N [[access-grant]]s to [[application]]s.
- **raises** N [[access-request]]s.
- **is referenced by** N [[ticket]]s (requester, affected user, or assignee).

## Business rules

- Atomic entity — implemented first, alongside [[location]].
- Offboarding a user must not erase history: assignments and grants are *released*, not
  deleted (soft delete + lifecycle timestamps).
- **Identity / auth:** the local User is the source of truth for the domain. Authentication is
  **deferred** ([[0016-auth-strategy-deferred]]); when it lands we integrate with an external IdP
  (OIDC) and map its `sub` to `externalId` — we do **not** implement our own auth. Current
  endpoints are **unauthenticated (dev-only)**.

## Conventions

- **ID:** `uuid()` — sensitive / externally-exposed entity ([[0005-id-strategy]]).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

## Fields

Implemented in `apps/api/prisma/schema.prisma` (`User` → table `users`). Validation schemas
(`UserSchema`, `CreateUserSchema`, `UpdateUserSchema`) live in `@lazyit/shared`
(`packages/shared/src/schemas/user.ts`) and are the source of truth for both api and web
([[shared-package]], [[0013-zod-validation-pipe]]).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` | `@default(uuid())`, `@db.Uuid` — sensitive/exposed ([[0005-id-strategy]]). |
| `email` | `string` | `@unique`, required. |
| `firstName` | `string` | required. |
| `lastName` | `string` | required. |
| `isActive` | `boolean` | `@default(true)`. Activation flag — see note below. |
| `externalId` | `string?` | `@unique`, nullable. Holds the IdP `sub` once auth is integrated; `null` until then ([[0016-auth-strategy-deferred]]). |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |
| `deletedAt` | `datetime?` | Soft delete — `null` while live; reads filter `deletedAt: null` ([[0006-soft-delete-and-auditing]]). |

> [!note] `isActive` vs `deletedAt` — independent concepts
> `isActive = false` means the person is **offboarded/disabled but retained** (tickets and past
> assignments still reference them) — this is the offboarding rule above. `deletedAt` means the
> record is **soft-deleted** (hidden from normal queries). A user can be inactive yet not
> deleted. Creation always starts active; deactivation is a `PATCH`.

## Endpoints

`apps/api/src/users/` (`UsersModule`): `GET /users` (excludes soft-deleted), `GET /users/:id`,
`POST /users`, `PATCH /users/:id`, `DELETE /users/:id` (soft delete). Bodies validated against the
shared schemas and documented via Swagger ([[0018-api-documentation-swagger]]). Also
`GET /users/:id/assignments?activeOnly=` lists the assets assigned to the user ([[asset-assignment]]).

Related: [[asset-assignment]] · [[access-grant]] · [[access-request]] · [[ticket]] ·
[[asset-centric]] · [[shared-package]] · [[0013-zod-validation-pipe]] ·
[[0016-auth-strategy-deferred]]
