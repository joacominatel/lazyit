---
title: AccessRequest
tags: [domain, entity]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# AccessRequest

> ⚪ planned · Area: Access · Implementation order: 5

## Purpose

A pending request for a [[user]] to gain access to an [[application]], with an **approval
workflow**. On approval it produces an [[access-grant]].

## Relationships

- **raised by / for** a [[user]].
- **targets** one [[application]].
- **produces** an [[access-grant]] when approved.

## Business rules

- Has a state workflow: requested → approved / rejected → provisioned.
- Approver(s) derive from the target [[application]].

> [!note] Relationship to tickets
> An access request resembles a [[ticket]] with a specialized workflow. Decide whether it
> is a distinct entity (as modeled here) or a ticket subtype when both areas are built.

## Conventions

- **ID:** `cuid()` — see [[0005-id-strategy]].
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

Related: [[access-grant]] · [[application]] · [[user]] · [[ticket]]
