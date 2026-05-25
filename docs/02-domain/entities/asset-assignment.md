---
title: AssetAssignment
tags: [domain, entity]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# AssetAssignment

> ⚪ planned · Area: Assets (core) · Implementation order: 3

## Purpose

The join entity linking an [[asset]] to its owners ([[user]]) over time. Carries
`assignedAt` / `releasedAt`, which turns ownership into **automatic history** rather than a
single mutable column — central to the asset-centric model ([[asset-centric]]). Ownership is
**many-to-many and concurrent**: an asset may have several active owners at once.

## Relationships

- **belongs to** one [[asset]].
- **belongs to** one [[user]].

## Business rules

- An assignment with `releasedAt = null` is *active*; setting `releasedAt` ends it without
  deleting the record (history is preserved).
- **Concurrent ownership (decided 2026-05-25):** an asset may have **multiple active
  assignments** at the same time (several `releasedAt = null` rows). There is **no uniqueness
  constraint** on the active owner — e.g. a shared server with several responsible people.
- Releasing one owner does not affect the others; reassigning a single owner = release that
  assignment + create a new one.
- A useful uniqueness guard is on the *pair*: at most one active assignment per
  `(asset, user)` — prevents duplicate active rows for the same person, while still allowing
  many users per asset. Confirm at implementation.

## Conventions

- **ID:** `cuid()` — see [[0005-id-strategy]].
- **Timestamps:** `createdAt`, `updatedAt`. The `releasedAt` field expresses lifecycle, not
  soft delete — assignments are never hard-deleted.

Related: [[asset]] · [[user]] · [[asset-history]] · [[asset-centric]]
