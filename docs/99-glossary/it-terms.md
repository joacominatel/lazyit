---
title: IT Terms
tags: [glossary]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# IT Terms

General IT/operations vocabulary. For lazyit's own domain objects, see
[[entities/_MOC|Entities]].

| Term | Meaning in lazyit's context |
| --- | --- |
| **Asset** | A tracked, individual thing the IT team owns ([[asset]]). Contrast with a consumable. |
| **Consumable** | A stock-counted item, not tracked individually ([[consumable]]). |
| **Access grant** | A user's active access to an application ([[access-grant]]). |
| **Access request** | A pending, approval-gated request for access ([[access-request]]). |
| **Provisioning** | Setting up access/hardware for a user (e.g. on onboarding). |
| **Deprovisioning / offboarding** | Revoking access and reclaiming assets when someone leaves. |
| **SLA** | Service Level Agreement — target response/resolution times for tickets. |
| **Runbook** | A step-by-step operational procedure (for operating lazyit; see [[05-runbooks/_MOC|Runbooks]]). |
| **CMDB** | Configuration Management Database — the inventory of assets and their relationships; lazyit's asset model plays this role. |
| **AD / LDAP** | Active Directory / directory service; an AD group is a kind of [[application]] you can grant access to. |
| **jsonb** | PostgreSQL binary JSON type; used for flexible asset `specs` ([[0007-flexible-asset-specs-jsonb]]). |
| **Soft delete** | Marking a row deleted (`deletedAt`) without removing it, for auditability ([[0006-soft-delete-and-auditing]]). |
| **Append-only** | A table whose rows are only ever inserted, never updated/deleted (history, ledgers). |

> [!note] Grow this as terms come up in tickets, ADRs and runbooks. Keep definitions
> lazyit-specific, not generic dictionary entries.
