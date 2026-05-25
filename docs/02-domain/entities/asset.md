---
title: Asset
tags: [domain, entity]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# Asset

> ⚪ planned · Area: Assets (core) · Implementation order: 2

## Purpose

The first-class citizen of lazyit ([[asset-centric]]): a single tracked thing the IT team
owns and is accountable for — a laptop, server, switch, license, etc. Each asset is a
concrete instance of a generic [[asset-model]].

## Relationships

- **is an instance of** one [[asset-model]] (make/model/generic specs).
- **lives at** one [[location]].
- **is owned via** N [[asset-assignment]] records (current + historical owners).
- **has** N [[asset-history]] entries (append-only state changes).
- **is referenced by** N [[ticket]]s.

## Business rules

- Asset-specific attributes that vary by type live in a flexible `specs` JSON field — see
  [[conventions]] and [[0007-flexible-asset-specs-jsonb]].
- Ownership is never a column on the asset; it is always expressed through
  [[asset-assignment]] so history is automatic.
- State transitions (e.g. in-stock → assigned → in-repair → retired) are logged in
  [[asset-history]].

## Conventions

- **ID:** `cuid()` (domain entity) — see [[0005-id-strategy]].
- **Timestamps / soft delete:** mutable domain entity → `createdAt`, `updatedAt`,
  `deletedAt`.

Related: [[asset-model]] · [[location]] · [[asset-assignment]] · [[asset-history]] ·
[[ticket]] · [[asset-centric]]
