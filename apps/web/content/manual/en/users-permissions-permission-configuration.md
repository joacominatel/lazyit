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

## Open the editor

Go to **Settings → Roles**. Each role shows who holds it and a short summary of what it can do. Admin
reads **Full access — not editable**. For Member or Viewer, choose **Edit permissions** to open the
**Role permissions** editor.

The editor works on **one role at a time**. Pick **Member** or **Viewer** at the top; Admin is shown
but locked.

## Three ways to edit

- **Presets** — **Start from a preset** applies a sensible ready-made set as a starting point. From
  there you can adjust individual capabilities. If your set matches no preset, lazyit labels it
  **Custom**.
- **Capability toggles** — plain-language switches grouped by area (Inventory, Access, Knowledge,
  Manage, Automation). Each toggle maps to one or more underlying permissions; flip it to grant or
  remove that capability for the role.
- **Fine-tune (advanced)** — an optional disclosure where each switch is a single raw permission
  (`area:action`), for exact control. Changing one here flips the role to a **Custom** set and updates
  the capability toggles above to match.

A live **What this role can do** summary shows, per area, whether the role ends up with **View & edit**,
**View only** or **Cannot access**, so you can sanity-check before saving. **Reset to defaults** puts
the role back to its shipped starting point.

## Admin-level grants are flagged, not blocked

You can give Member or Viewer powerful, admin-level capabilities — deleting records, granting
application access — and you can also remove a sensitive read. These are real, legitimate choices
(handing a trusted Member the ability to delete is allowed), so lazyit does **not** stop you. Instead
it flags admin-level grants with an **Admin-level** marker and routes a save that includes one through
a short confirmation that lists the effects. Confirm, and the change is saved.

Admin itself is the one thing you can never edit: the editor cannot grant, revoke or scope Admin.

## What saving does

Saving replaces the chosen role's permission set as a whole. The change:

- takes effect on the **next action** each affected user performs — they do not need to sign out;
- is **recorded** (each permission granted or revoked is written to the activity history with who
  made the change), so the edit is auditable;
- applies **per area, not per record**. If a role can read assets, it can read **all** assets. lazyit
  does not have general per-record permissions. The two deliberate exceptions are Knowledge Base
  folders and Secret Manager vaults, where access is scoped to a folder or a vault.

## Permissions stay inside lazyit

These permissions are **lazyit-only**. They are never written to your identity provider — the IdP
knows nothing about them. Only the three coarse roles are mirrored to the IdP (when one is configured);
the fine-grained permission tuning you do here lives entirely in lazyit.

See [Roles](/help/users-permissions-roles) for the role model and [Permissions](/help/permissions)
for the area/action model and the shipped defaults.
