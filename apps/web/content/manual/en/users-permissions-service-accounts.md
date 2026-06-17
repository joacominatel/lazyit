---
title: Service accounts
category: users-permissions
subcategory: service-accounts
order: 4
---

# Service accounts

A **service account** is a non-human credential for automation — a CI runner that registers a freshly
imaged asset, a nightly script that reconciles stock, an integration that opens access grants. It calls
the lazyit API with its own token instead of a person's sign-in.

Service accounts are a separate kind of principal from users: they never appear in the user directory,
never count toward the last-admin rule, and do not depend on your identity provider. You manage them in
**Settings → Service accounts** (admin only).

## How a service account is authorized

A service account is authorized **only by the permissions you grant it** — from the same catalog users
use. It **never** inherits a role and is never admin-equivalent.

- **You must grant at least one permission.** A service account with none could authenticate but do
  nothing.
- **It is fail-closed.** A service account can act only on endpoints whose required permission it fully
  holds. Unlike a signed-in person, it does not get a pass on unannotated routes — anything it was not
  explicitly granted returns a permission error.
- **Grant the minimum it needs.** Scope each account to exactly the capabilities its job requires.
  You can grant deletes and other admin-level capabilities; the picker flags them as **Admin-level**.
- **Two capabilities are never grantable.** A service account can never hold **Change instance
  settings** or **Manage users**. Either would make it admin-equivalent (able to mint more accounts or
  create a human admin), so lazyit rejects them — even if you try to set them.

## The token (shown once)

Creating an account mints a token. **It is shown exactly once**, right after you create the account.

- Copy it immediately and store it somewhere safe. lazyit keeps only a hash of the token, so it can
  **never** be shown or recovered again.
- If you lose it, you cannot retrieve it — **rotate** the account to mint a fresh one.
- A short, non-secret prefix (e.g. `lzit_sa_…`) is shown on the account row so you can recognize which
  credential is which without revealing anything usable.

There is a **Test it works** helper that gives you ready-to-run terminal checks, scoped to the
permissions the account holds, so you can confirm the token authenticates and is scoped as expected
before wiring it into a system.

## Managing accounts over time

- **Active toggle** — a soft disable. Turn it off and the token stops authenticating, without revoking
  the account; turn it back on to resume.
- **Expiry (optional)** — set an *Expires at* time and the token is rejected after it. Leave it empty
  for no expiry.
- **Rotate** — mints a new token and **immediately stops the old one working**. Any system using the
  old token must be updated. The new token is, again, shown only once.
- **Revoke (delete)** — disables the credential. It is kept for history (a soft delete) and can be
  **restored** later by an admin; revoked accounts are hidden unless you choose to include them.
- **Audit** — every create, rotate, permission change, revoke and restore is recorded, and any action
  a service account performs is attributed to that account in the activity history, never to a person.

## System-managed accounts

Some accounts are created and owned by lazyit itself — for example the account the Applications Workflow
Engine runs every workflow as. These carry a **system-managed** badge and cannot be edited, rotated or
revoked, because the feature that owns them needs them to keep working.

See [Permissions](/help/permissions) for the capability catalog and
[Permission configuration](/help/users-permissions-permission-configuration) for the same area/action
model applied to roles.
