---
title: User lifecycle
category: users-permissions
subcategory: user-lifecycle
order: 5
---

# User lifecycle

This page covers the full life of a person in lazyit: creating them, giving them a role and a head
start, cloning an existing colleague, resetting a password, offboarding, and restoring. All of it
lives in the **Users** section and requires the **Manage users** capability (admin by default).

## Create a user

Choose **New user** and fill in the person's identity:

- **First and last name**, and **Email** — the email is the account-linking key for your identity
  provider, must be unique, and a change is mirrored to the IdP.
- **Role** — defaults to read-only; set it here or change it later. See
  [Roles](/help/users-permissions-roles).
- **Employee number** and **Username** (both optional) — directory details, unique among active users.
  When lazyit manages passwords itself, the username **is** a sign-in identifier — the person can sign
  in with either their username or their email. Behind an identity provider it is only a directory
  handle, never a credential.
- **Manager** (optional) — either an existing lazyit user **or** a free-text name, not both.

**Sign-in credential.** When lazyit manages credentials (the bundled identity provider), you set a
**temporary password** so the person can sign in; they choose their own at first login. lazyit never
stores this password — it is set on the identity provider and replaced when the user signs in, and it
is shown only once for hand-off. If you bring your own identity provider, this step does not appear —
manage the credential in your IdP.

**Head start (optional).** You can assign one asset and grant one application access right from the
create form, so the new person starts with what they need.

## Clone a user

To onboard someone who mirrors a colleague ("same access as Ana"), open a user and choose **Clone**.
You pick a fresh, unique email and a role, then choose which of the source's **assets** and
**application access** carry over.

By default, cloned access is **recorded only** — bookkeeping, no external effect. There is an opt-in
switch to **provision the new user in these applications**, which runs the provisioning workflows for
the selected apps. After cloning, lazyit tells you what carried over and lists anything that was
skipped (and why). A selected asset or application that has since been **deleted** is skipped rather
than copied, so the clone never revives a retired asset or a decommissioned application.

## Reset a password

On a user's detail page, **Reset password** starts a password reset for that person. What it does
depends on who owns passwords in your instance, and the action adapts on its own — you never have to
remember which mode you are in.

**When an identity provider owns passwords.** lazyit asks your provider to email the person a reset
link. lazyit never sees or sets the password — it only triggers the provider, and delivery depends on
the provider's email being configured. The action is unavailable for an inactive user (reactivate them
first) or for an account with no identity-provider link (in that case the reset is managed entirely in
your IdP).

**When lazyit owns passwords.** You choose how the reset reaches the person:

- **Send a reset link by email** — the person receives a single-use link at their address and chooses
  their own password; lazyit never sees it. The confirmation tells you exactly which address the link
  went to and how long it stays valid. This option needs outbound
  [email (SMTP)](/help/configuration-smtp-email) and a public URL for your instance; when either is
  missing the option is greyed out and lazyit names the one to fix, instead of pretending the mail went
  out. Under this option there is a **Sign this user out everywhere** checkbox, **off by default** —
  a link does not change the current password, so the person's open sessions are still legitimately
  theirs. Turn it on when you believe the account is compromised.
- **Generate a temporary password** — lazyit mints a one-time password and shows it to you **once**, to
  hand over yourself. It is the way out when the person cannot reach their mailbox, so it stays
  available even when email works. It replaces their password immediately and therefore **always**
  signs them out everywhere; they must choose a new password at their next sign-in.

> [!IMPORTANT]
> A temporary password is shown **once**. Copy it before closing the dialog — it is never displayed
> again and cannot be looked up later. If you lose it, simply run the reset again.

The action is unavailable for an inactive user (reactivate them first) and for a directory person who
has no login account yet — onboard them with a temporary password instead, which gives them their
first one.

If a reset fails — email not configured, the message could not be sent, the account is not eligible —
lazyit says so plainly and keeps the dialog open, so you can read the reason and pick the other
option.

## Offboard a user

When someone leaves, open them and choose **Offboard**. lazyit shows the full impact up front — the
**assets to return** and the **application access to revoke** — and then, on confirm:

- **revokes** the person's active application access,
- **removes** the person's access to every [Secret vault](/help/secret-manager-vaults-members) they
  belonged to (their cryptographic membership is dropped),
- **releases** the assets they hold,
- **archives** the user (a soft delete) so they can no longer be assigned assets.

It all happens together: if any step fails, the whole offboarding is rolled back, so a departing person
is never left half-offboarded (archived but still holding access).

**Rotate the secrets they could read.** If the person was a member of any Secret vault, the confirmation
lists those vaults (with how many secrets each holds) as a reminder to **rotate those secrets by hand**.
Removing their membership stops any *new* reads, but because they could already read those vaults, the
values themselves should be changed. lazyit **cannot rotate them for you** — it is zero-knowledge and
never sees the plaintext, so it can't re-encrypt on your behalf. This is a prompt, not an automatic
action. (Who removed whose vault access, and when, is recorded in the Secret Manager's audit trail.)

**Nothing is destroyed.** The person and their history are preserved for the record. You can fill in a
handover note and print a **return act** (with company name and signature lines) to sign on paper at
hand-off. Offboarding is valid even when the person holds nothing — it still stands as a record of
their departure.

## Find users by role

The Users list has a **role filter** alongside the status and directory filters: pick **Admin**,
**Member** or **Viewer** to show only people who hold that role. It is server-side, so it stays
accurate at any team size, and the choice lives in the page address — a filtered list is shareable and
bookmarkable. The [Roles](/help/users-permissions-roles) screen's **View N members** links land here
pre-filtered, so the Users list is the one place you browse and manage role membership.

## Directory people

A **directory** person is a User without a login — created by the [bulk import](/help/assets-bulk-import)
as an asset's "assigned to", with no account in your identity provider. They give an asset an owner on
record before that owner can sign in.

- **In the Users list** a directory person carries a **Directory** badge next to their name, and the
  **directory filter** (next to the status filter) narrows the list to *Directory only*, *Accounts
  only*, or everyone.
- **They link to a real account on first sign-in** through your identity provider, when the verified
  email matches — at which point the badge disappears and they become a normal account. A directory
  person imported **without a real email never links automatically**.
- **Give them an account now.** On a directory person's page there is an admin-only (Manage users) action
  to onboard them, and what it does depends on how your instance signs people in:
  - **Bundled identity provider** — **Create OIDC account** provisions them in the identity provider
    immediately. The provider requires a real email, so the button is disabled until the person has one —
    edit the person and add a real email first.
  - **Local authentication mode** — **Onboard with a temporary password** creates their login right here
    and shows a **one-time temporary password** to hand off. The password is shown **only once** (copy it
    then), the person **must change it at first sign-in**, and onboarding **keeps their existing role** —
    it never grants extra access. No email is required.
  - **Your own OIDC provider (BYOI)** — lazyit cannot create accounts for you, so the option is replaced
    with a short note; imported people sign in through your identity provider instead.

## Restore a user

Offboarded users are archived, not deleted. To bring one back, show archived users in the Users list
and choose **Restore**. Restoring is admin-only.

> Offboarding (and any deactivation) frees the resources a person held but keeps the full history —
> who held which asset and when, and what access they had — because lazyit is built so that people
> rotate while the record persists.

See [Roles](/help/users-permissions-roles) for assigning access levels and
[Permissions](/help/permissions) for what each role can do.
