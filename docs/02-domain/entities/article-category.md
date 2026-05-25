---
title: ArticleCategory
tags: [domain, entity]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# ArticleCategory

> ⚪ planned · Area: Knowledge Base · Implementation order: 7

## Purpose

A grouping for knowledge-base [[article]]s — e.g. Onboarding, Network, Backups,
Troubleshooting. Organizes the KB for browsing and search.

## Relationships

- **groups** N [[article]]s.

## Business rules

- Curated set, consistent with the opinionated philosophy ([[vision]]).
- May be hierarchical later; start flat unless needed.

## Conventions

- **ID:** `cuid()` — see [[0005-id-strategy]].
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

Related: [[article]] · [[article-version]]
