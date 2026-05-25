---
title: AccessGrant
tags: [domain, entity]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# AccessGrant

> ⚪ planned · Area: Access · Implementation order: 5

## Purpose

A [[user]]'s access to an [[application]] — the join entity that answers "**who can access
what?**". Like [[asset-assignment]], it should carry lifecycle timestamps so granting and
(critically) *revoking* access is auditable ([[problem-space]]).

## Relationships

- **belongs to** one [[user]].
- **belongs to** one [[application]].
- May originate from an approved [[access-request]].

## Business rules

- A grant with no revocation timestamp is *active*; revoking ends it without deleting the
  record (offboarding/audit trail).
- Role/level within the application (e.g. admin vs member) may be captured here.

## Conventions

- **ID:** `cuid()` — see [[0005-id-strategy]].
- **Timestamps:** `createdAt`, `updatedAt`. Revocation is a lifecycle field; grants are not
  hard-deleted.

Related: [[user]] · [[application]] · [[access-request]]
