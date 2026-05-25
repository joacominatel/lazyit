---
title: TicketComment
tags: [domain, entity]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# TicketComment

> ⚪ planned · Area: Tickets · Implementation order: 4

## Purpose

A single message in a [[ticket]]'s discussion thread — the running narrative of work,
questions and resolution notes.

## Relationships

- **belongs to** one [[ticket]].
- **authored by** one [[user]].

## Business rules

- Comments may be edited (→ `updatedAt`) but are soft-deleted, never hard-deleted, to keep
  the thread auditable.
- Consider an internal/external (public) flag if/when end users see tickets.

## Conventions

- **ID:** `cuid()` — see [[0005-id-strategy]].
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

Related: [[ticket]] · [[user]]
