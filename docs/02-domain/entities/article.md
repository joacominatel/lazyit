---
title: Article
tags: [domain, entity]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# Article

> ⚪ planned · Area: Knowledge Base · Implementation order: 7

## Purpose

A knowledge-base document: a procedure, troubleshooting guide or runbook. The internal
documentation pillar of lazyit ([[vision]]).

## Relationships

- **grouped by** one [[article-category]].
- **versioned by** N [[article-version]]s.
- **authored / edited by** [[user]]s.

## Business rules

- The `Article` holds current/canonical metadata; the body's history lives in
  [[article-version]] so edits are traceable.
- May reference assets, tickets or applications it documents (linking TBD when built).

## Conventions

- **ID:** `cuid()` — see [[0005-id-strategy]].
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

Related: [[article-category]] · [[article-version]] · [[05-runbooks/_MOC|Runbooks]]
