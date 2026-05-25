---
title: AssetCategory
tags: [domain, entity]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# AssetCategory

> ⚪ planned · Area: Assets (core) · Implementation order: 2

## Purpose

Classification for [[asset-model]]s — e.g. Laptop, Desktop, Server, Switch, License,
Peripheral. Drives grouping, filtering and (potentially) which `specs` shape an
[[asset]] of that type is expected to have.

## Relationships

- **classifies** N [[asset-model]]s.

## Business rules

- Categories are a small, curated set (opinionated, per [[vision]]) — not free-form tags.
- May later define a recommended `specs` schema/template for its models.

## Conventions

- **ID:** `cuid()` — see [[0005-id-strategy]].
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

Related: [[asset-model]] · [[asset]] · [[conventions]]
