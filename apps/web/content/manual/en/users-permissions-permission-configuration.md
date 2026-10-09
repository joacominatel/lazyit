---
title: Permission configuration
category: users-permissions
subcategory: permission-configuration
order: 3
---

# Permission configuration

An admin can tune what **Member** and **Viewer** are allowed to do, choosing from the fixed permission
catalog. **Admin is not configurable** — it always holds the complete catalog and the screen shows it
locked. This page walks through the editor.

You need the **Change instance settings** capability (admin by default) to open it.

## Open the matrix

Go to **Settings → Roles & permissions**. The page is one table: **capabilities** in the rows, the three
**roles** in the columns, so you compare Member and Viewer side by side.

- **Admin** is a locked reference column: every capability is granted and nothing can be changed.
- **Member** and **Viewer** are editable. Each column header shows how many people hold the role — click
  it to open the [Users list](/help/users-permissions-user-lifecycle) filtered to that role — and the
  role's **preset**.

The **?** next to the page title explains the three roles and reminds you that these permissions stay
inside lazyit.

## Three ways to edit

- **Presets** — the selector in a role's column header applies a ready-made set to that role:
  **Editor**, **Read-only** or **Inventory operator**. From there you can adjust individual
  capabilities. When the set matches no preset, the selector reads **Custom**.
- **Capability checkboxes** — plain-language capabilities grouped by area (Inventory, Access, Knowledge,
  Manage, Automation, AI). Each maps to one or more underlying permissions; tick or clear the box in a
  role's column to grant or remove that capability for the role. Each capability's **?** says what it
  allows. The **AI** area holds **Use the AI assistant** (`ai:use`) and **Connect external AI agents
  (MCP)** (`ai:connect`); neither is admin-level, because the assistant and agents only ever act with
  the role's own permissions — see [AI assistant — overview](/help/ai-assistant-overview#who-can-use-it).
  A box showing a dash means the role holds only **part** of that capability (set in Fine-tune); ticking
  it grants the whole capability.
- **Fine-tune (advanced)** — below the matrix, an optional disclosure listing every raw permission
  (`area:action`) with a checkbox per role, for exact control. Changing one here flips that role to a
  **Custom** set, and the matching capability shows as partly granted in the matrix.

Each area's heading collapses and expands, and shows a **granted/total** count per role — *6/10* means
the role holds six of the area's ten capabilities fully — so you can read the whole matrix without
opening every area. A changed cell is tinted until you save. **Reset to defaults** puts both Member and
Viewer back to their shipped starting point (still unsaved).

## Admin-level grants are flagged, not blocked

You can give Member or Viewer powerful, admin-level capabilities — deleting records, granting
application access — and you can also remove a sensitive read. These are real, legitimate choices
(handing a trusted Member the ability to delete is allowed), so lazyit does **not** stop you. Instead
it flags admin-level capabilities with a small **⚠** marker (its tip explains why) and routes a save
that grants one through a short confirmation that lists the effects. The same confirmation appears when
a save removes a read a role had. Confirm, and the change is saved; any other save goes straight
through.

Admin itself is the one thing you can never edit: the matrix cannot grant, revoke or scope Admin.

## What saving does

Your edits to both roles are held together until you save. The bar under the matrix counts them —
**Save 3 changes** — and **Discard** puts everything back as it was saved. Saving writes Member's and
Viewer's permission sets together, as a whole. The change:

- takes effect on the **next action** each affected user performs — they do not need to sign out;
- is **recorded** (each permission granted or revoked is written to the activity history with who
  made the change), so the edit is auditable;
- applies **per area, not per record**. If a role can read assets, it can read **all** assets. lazyit
  does not have general per-record permissions. The two deliberate exceptions are Knowledge Base
  folders and Secret Manager vaults, where access is scoped to a folder or a vault.

## Your changes survive updates

What you save here stays in place when lazyit is updated. A permission you removed from Member or Viewer
is not given back by a later update.

When an update adds a **new** permission, each role receives that permission's shipped default **once**,
on the first update that includes it. After that it behaves like any other permission: if you remove it,
it stays removed through every later update.

> [!IMPORTANT]
> Before this behavior shipped, an update could silently give back a default permission you had removed.
> After the update that introduces it, open this screen once and check that Member and Viewer hold only
> what you intend. From then on, your changes are kept.

## Permissions stay inside lazyit

These permissions are **lazyit-only**. They are never written to your identity provider — the IdP
knows nothing about them. Only the three coarse roles are mirrored to the IdP (when one is configured);
the fine-grained permission tuning you do here lives entirely in lazyit.

See [Roles](/help/users-permissions-roles) for the role model and [Permissions](/help/permissions)
for the area/action model and the shipped defaults.
