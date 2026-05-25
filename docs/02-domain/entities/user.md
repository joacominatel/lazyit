---
title: User
tags: [domain, entity]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# User

> ⚪ planned · Area: People · Implementation order: 1 (atomic, no dependencies)

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
- Likely the integration point for authentication (NextAuth vs better-auth — undecided;
  see [[stack]]).

## Conventions

- **ID:** `uuid()` — sensitive / externally-exposed entity ([[0005-id-strategy]]).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

Related: [[asset-assignment]] · [[access-grant]] · [[access-request]] · [[ticket]] ·
[[asset-centric]]
