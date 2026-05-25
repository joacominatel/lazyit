---
title: Application
tags: [domain, entity]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# Application

> ⚪ planned · Area: Access · Implementation order: 5

## Purpose

Something a [[user]] can be granted access to: a SaaS product (Jira, GitHub), an internal
app, an AD/LDAP group, or a service. The catalog of "things you can request access to".

## Relationships

- **granted via** N [[access-grant]]s (to [[user]]s).
- **requested via** N [[access-request]]s.

## Business rules

- Has a `type` distinguishing SaaS / internal / AD-group / service (affects how access is
  provisioned and how requests are approved).
- May define who its approver(s) are, feeding the [[access-request]] workflow.

## Conventions

- **ID:** `cuid()` — see [[0005-id-strategy]].
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

Related: [[access-grant]] · [[access-request]] · [[user]]
