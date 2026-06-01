---
title: Entities — MOC
tags: [moc, domain]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# Entities — Map of Content

> [!info] Conceptual-only
> Each note describes an entity's **purpose, relationships and business rules** — not its
> fields. Field-level schemas are deliberately omitted until the entity exists in Prisma,
> to avoid doc↔schema drift. When a model lands, add a "Fields" section linking to the
> Prisma model.

| Status legend | |
| --- | --- |
| 🟢 implemented | Exists in `schema.prisma` |
| 🟡 next | Next up in implementation order |
| ⚪ planned | Documented, not yet implemented |

## Assets (core)

- 🟢 [[asset]] — the first-class citizen; a tracked physical/logical thing.
- 🟢 [[asset-model]] — generic make/model/specs an asset is an instance of.
- 🟢 [[asset-category]] — classification of models (laptop, switch, server…).
- 🟢 [[location]] — where an asset physically lives.
- 🟢 [[asset-assignment]] — join entity: who owns an asset, with history.
- ⚪ [[asset-history]] — append-only log of asset state changes.

## People

- 🟢 [[user]] — central to access, peripheral to assets.

## Tickets

- ⚪ [[ticket]] — cross-cutting work item; references assets and/or users.
- ⚪ [[ticket-comment]] — discussion thread on a ticket.

## Access

- 🟢 [[application]] — a SaaS, internal app or service access is granted on.
- 🟢 [[application-category]] — user-managed grouping of applications.
- 🟢 [[access-grant]] — a user's access to an application, with grant/revoke history.
- ⚪ [[access-request]] — approval workflow; **deferred** by [[0023-access-management-design]].

## Consumables

- ⚪ [[consumable]] — stock-counted item (cables, mice, toner…).
- ⚪ [[consumable-movement]] — stock in/out movement.

## Knowledge Base

- 🟢 [[article]] — knowledge-base document (markdown); simple wiki.
- 🟢 [[article-category]] — user-managed grouping of articles.
- ⚪ [[article-version]] — historical version of an article; deferred by [[0021-knowledge-base-design]].

## Dashboard (derived)

- 🟢 [[recent-activity]] — read-only DB **view** unifying asset/access/stock activity into one feed.

Model overview & order: [[02-domain/_MOC|Domain]]. Conventions: [[conventions]].
