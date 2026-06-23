---
title: Roles
category: users-permissions
subcategory: roles
order: 1
---

# Roles

lazyit ships with **three fixed roles**: **Admin**, **Member** and **Viewer**. Every user has exactly
one. You cannot create, rename or delete roles — the set is the same on every install, which keeps the
model small and predictable for a small IT team.

A role is the access *level* a person holds. What that level actually lets them do is decided by
**permissions** (see [Permissions](/help/permissions)), and for Member and Viewer those permissions
can be tuned. The role is the thing a user *has*; permissions are what a role *grants*.

## The three roles

- **Admin** — full control of the instance. An admin can do everything: manage users and their roles,
  change instance settings, delete records, grant and revoke application access, and adjust what
  Member and Viewer may do. Admin **always holds every permission** and that set is never editable —
  this guarantees the instance is always operable by someone with full power.
- **Member** — the everyday working role. By default a Member can read and create/edit most things
  (assets, applications, consumables, the Knowledge Base, locations, models, categories) but cannot
  delete records or perform admin-only actions.
- **Viewer** — read-only. By default a Viewer can look at most areas but change nothing. A few
  sensitive views (the user directory and the access-grant ledger) are also hidden from Viewer by
  default.

## The Roles overview

**Settings → Roles** shows one card per role with, for each: a **live holder count** (how many active
users currently hold it), a short reminder of what the role can do, and a **View N members** link. That
link opens the [Users list](/help/users-permissions-user-lifecycle) filtered to that role — the Users
list is where you actually browse and manage who holds it, with search, sort and paging. The cards show
counts only; they no longer list members inline. From the same cards you can open **Edit permissions**
for Member and Viewer (Admin is full access and locked).

## How a role is assigned

- **The first user is always Admin.** The very first person provisioned on a fresh install — whether
  through the setup wizard or the first sign-in — becomes Admin, so a new instance is never left
  without an administrator.
- **Everyone after that starts as Viewer.** Newly provisioned users default to the least-privileged
  role (read-only) until an admin promotes them. This is deliberate: a new identity can look but not
  change anything until someone grants more.
- **Admins change roles from the Users section.** Open a user (or use the role cell in the Users
  list) and pick **Admin**, **Member** or **Viewer**. lazyit asks you to confirm the change.

## Built-in safety rules

Two guardrails protect the instance from being locked out or quietly escalated:

- **The last admin cannot be removed.** lazyit refuses to demote, deactivate or offboard the final
  remaining admin — there must always be at least one. You will see a clear message instead of the
  change going through.
- **You cannot change your own role.** An admin cannot promote or demote themselves; a role change
  must be made by one admin on another. This prevents a single person quietly elevating their own
  access. (You can still edit your own name, email and other details.)

## A note on your identity provider

If you bring your own identity provider (BYOI), roles are managed **locally in lazyit** — they are not
read from a token and are used only for authorization inside the app. lazyit keeps its own copy of the
role; you assign and change it here, in the Users section.

For the full breakdown of what each role can do — and how to tune Member and Viewer — see
[Permissions](/help/permissions) and [Permission configuration](/help/users-permissions-permission-configuration).
