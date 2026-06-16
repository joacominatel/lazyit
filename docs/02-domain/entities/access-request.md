---
title: AccessRequest
tags: [domain, entity]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# AccessRequest

> ⚪ planned · Area: Access · Implementation order: 5

> [!note] Explicitly deferred (not just unbuilt)
> Access management ships **without an approval workflow** by decision
> ([[0023-access-management-design]]): [[access-grant]]s are created **directly** for now. This note
> records the intended shape *when* a workflow is added — a **non-destructive** future addition (a
> new table that produces an [[access-grant]] on approval). The **approver** concept (briefly
> sketched on [[application]] in an earlier draft, since removed) belongs here, not on Application.

## Purpose

A pending request for a [[user]] to gain access to an [[application]], with an **approval
workflow**. On approval it produces an [[access-grant]].

## Relationships

- **raised by / for** a [[user]].
- **targets** one [[application]].
- **produces** an [[access-grant]] when approved.

## Business rules

- Has a state workflow: requested → approved / rejected → provisioned.
- Approver(s) would be defined as part of this workflow (where to attach them — the target
  [[application]], a team, or a role — is a design choice for when it's built).

> [!note] Relationship to tickets — question closed (CEO 2026-06-16)
> lazyit will NOT have a ticketing pillar (see [[vision]] non-goals). AccessRequest is a
> distinct entity in its own right — the ticket-subtype overlap question is moot.

## Conventions

- **ID:** `cuid()` — see [[0005-id-strategy]].
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

Related: [[access-grant]] · [[application]] · [[user]]
