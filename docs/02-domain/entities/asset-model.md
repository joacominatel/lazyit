---
title: AssetModel
tags: [domain, entity]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# AssetModel

> ⚪ planned · Area: Assets (core) · Implementation order: 2

## Purpose

The generic make/model definition an [[asset]] is an instance of — e.g. "Dell Latitude
7440", "Cisco Catalyst 9300". Holds attributes common to all units of that model
(manufacturer, model name, generic specs), so individual assets don't repeat them.

## Relationships

- **classified by** one [[asset-category]].
- **has** N [[asset]] instances.

## Business rules

- A model captures *type-level* facts; per-unit facts (serial, the flexible `specs`, owner)
  belong to the [[asset]].
- Removing a model with existing assets is disallowed (soft delete only; assets keep
  referencing it).

## Conventions

- **ID:** `cuid()` — see [[0005-id-strategy]].
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

Related: [[asset]] · [[asset-category]] · [[conventions]]
