---
title: Permissions
order: 1
category: users-permissions
subcategory: permissions
---

# Permissions

lazyit decides who can do what with a small, predictable model: **three fixed roles**, and a
**configurable set of permissions** behind each role. This page explains both in plain language and
shows the default of who-can-do-what.

## The three roles

Every user has exactly one role. The roles are fixed — you cannot create new ones — and they are the
same on every install:

- **Administrator** — full control of the instance. An administrator can do everything: manage
  users, change settings, delete records, and adjust what the other roles may do. This is
  deliberate and cannot be reduced; an administrator is always all-powerful.
- **Member** — the everyday working role. Members read and create/update most things (assets,
  applications, consumables, the Knowledge Base), but by default cannot delete records or perform
  administrator-only actions.
- **Viewer** — read-only. Viewers can look at most areas but cannot change anything, and a few
  sensitive areas are hidden from them by default.

## How permissions work

Each role holds a set of **permissions**. A permission is a single capability written as
`area:action` — for example `asset:write` (create or edit assets) or `consumable:read` (view
consumables). When you do something in lazyit, it checks whether your role holds the matching
permission.

The list of possible permissions (the *catalog*) is fixed and ships with the product — it cannot be
typed wrong or invented. What you **can** change is which permissions **Member** and **Viewer**
hold. **Administrator always holds every permission and cannot be edited** — this keeps the instance
safe to operate (there is always a fully capable admin).

Administrators tune Member and Viewer from the role-permission settings screen, choosing from
plain-language capabilities grouped by area, with one-click presets as a starting point.

## Who can do what (defaults)

These are the **default** capabilities for a fresh install. An administrator can grant Member or
Viewer more (or take some away) from the settings screen — these are the starting points, not hard
limits.

| Capability | Administrator | Member | Viewer |
| --- | :---: | :---: | :---: |
| **View** most areas (assets, applications, consumables, Knowledge Base, locations, models, categories, dashboard, search) | Yes | Yes | Yes |
| **View** the user directory | Yes | Yes | No |
| **View** who-has-access-to-what (access grants) | Yes | Yes | No |
| **Create / edit** records (assets, applications, consumables, Knowledge Base, …) | Yes | Yes | No |
| **Delete** records | Yes | No | No |
| **Grant / revoke** application access | Yes | No | No |
| **Manage users** (create, edit, change role, offboard, restore) | Yes | No | No |
| **Change instance settings** (including permissions) | Yes | No | No |
| **Activity history / reports** | Yes | No | No |
| **Notifications** (the in-app bell) | Yes | No | No |
| **Secret Manager** (see and manage vaults) | Yes | No | No |

A few notes on the defaults:

- **Two sensitive views are hidden from Viewer**: the user directory and the access-grant ledger
  (who has access to what). Administrators and Members keep them.
- **A few areas are administrator-only by default**: the estate-wide activity history, the
  notification bell, and the Secret Manager. These are the most sensitive surfaces, so they start
  locked to administrators. An administrator can still grant them to Member or Viewer if they choose.
- **Deleting** records and **granting application access** are administrator-only by default.

## Tuning Member and Viewer

When you give Member or Viewer an administrator-level capability — such as the ability to delete
records or to grant application access — lazyit marks it clearly and asks you to confirm, because it
is a meaningful delegation. It does not stop you: handing a trusted Member the ability to delete is a
legitimate choice. Administrator, by contrast, is never editable.

> Permissions are about **areas**, not individual records. lazyit does not have per-record access
> control as a general feature — if a role can read assets, it can read all assets. (The Knowledge
> Base folders and the Secret Manager vaults are the two deliberate exceptions, where access is
> scoped to a folder or a vault.)
