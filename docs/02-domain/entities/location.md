---
title: Location
tags: [domain, entity]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# Location

> ⚪ planned · Area: Assets (core) · Implementation order: 1 (atomic, no dependencies)

## Purpose

Where an [[asset]] physically lives — office, room, rack, warehouse, "remote / with
employee". Answers half of the core audit question "what do we have and **where is it**?"
([[problem-space]]).

## Relationships

- **holds** N [[asset]]s.

## Business rules

- Atomic entity — no dependencies; implemented first alongside [[user]].
- May be hierarchical later (site → room → rack); start flat unless needed.

## Conventions

- **ID:** `cuid()` — see [[0005-id-strategy]].
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

Related: [[asset]] · [[conventions]]
