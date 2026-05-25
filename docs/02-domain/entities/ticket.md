---
title: Ticket
tags: [domain, entity]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# Ticket

> ⚪ planned · Area: Tickets · Implementation order: 4

## Purpose

A unit of work — incident, request, change, problem. **Cross-cutting**: a ticket may
reference an [[asset]], a [[user]], or both, tying together the inventory and the people
sides of the model.

## Relationships

- **may reference** an [[asset]] (the thing involved).
- **may reference** [[user]]s (requester / affected / assignee).
- **has** N [[ticket-comment]]s.

## Business rules

- Has a **state workflow** (e.g. open → in-progress → resolved → closed), a `priority`,
  and a `type`. Exact states are TBD when implemented.
- A ticket need not reference an asset (e.g. a pure access or general request) — but when
  it does, it shows up in that [[asset]]'s timeline.

> [!note] Possible overlap with access
> Some requests are really [[access-request]]s with their own approval workflow. Decide
> whether access requests are a *kind of* ticket or a separate flow when both are
> implemented (orders 4 and 5).

## Conventions

- **ID:** `cuid()` — see [[0005-id-strategy]].
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

Related: [[ticket-comment]] · [[asset]] · [[user]] · [[access-request]]
