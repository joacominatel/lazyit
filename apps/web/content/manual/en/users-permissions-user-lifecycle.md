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

- **First and last name**, and **Email** — the email must be unique. With your own OIDC provider it is
  also the account-linking key: the person's first sign-in links to this record by verified email. A
  later change stays in lazyit and is not sent to the provider.
- **Role** — defaults to read-only; set it here or change it later. See
  [Roles](/help/users-permissions-roles).
- **Employee number** and **Username** (both optional) — directory details, unique among active users.
  When lazyit manages passwords itself, the username **is** a sign-in identifier — the person can sign
  in with either their username or their email. Behind an identity provider it is only a directory
  handle, never a credential.
- **Manager** (optional) — either an existing lazyit user **or** a free-text name, not both.

**Sign-in credential.** With **local accounts**, you set a **temporary password** so the person can
sign in; they must choose their own at first login, and it is shown only once for hand-off. lazyit
stores it only as a **hash** — never the password you typed, so nobody, an administrator included, can
read it back. A lost hand-off is not a dead end: reset the password (see below) rather than trying to
look it up. With your own OIDC provider this step does not appear — create the person in your provider
with the same email, and manage the credential there.

**Head start (optional).** You can assign one asset and grant one application access right from the
create form, so the new person starts with what they need.

## A person's page

Opening a user shows their record, laid out like an asset's page.

- **The summary card** at the top: name, status, role, and the email (with a copy button), username
  and employee number. Under it, **key facts** count the **assets held**, the **application access**
  and the **articles** they wrote; select a count to open its tab. The manager sits beside them.
- **Needs attention** items appear only when something needs follow-up: access that expires within the
  next 30 days, access that has expired and is about to be revoked, and assets the person hasn't
  acknowledged receiving yet.
- **Tabs**: **Assets** (each with its asset tag, model, category, status and whether receipt was
  acknowledged), **Access** (expired and soon-to-expire access listed first), **Articles**,
  **Consumables**, and **History**, one list of the assets they returned and the access they lost,
  most recent first. Each tab only appears to people allowed to see what it lists. The open tab is
  kept in the page address, so a shared link opens on the same tab.
- **The side column** holds the **Profile**: role (editable with *Manage users*), manager, employee
  number, username, email and dates. For a directory person it also explains how to give them a sign-in
  account.

The header keeps **Reset password** (local accounts only) and **Edit** in sight. **Clone** and
**Offboard** are in the **⋯** menu next to them, with Offboard set apart so it isn't clicked by mistake.

## Clone a user

To onboard someone who mirrors a colleague ("same access as Ana"), open a user and choose **Clone** from the **⋯** menu.
You pick a fresh, unique email and a role, then choose which of the source's **assets** and
**application access** carry over.

By default, cloned access is **recorded only** — bookkeeping, no external effect. There is an opt-in
switch to **provision the new user in these applications**, which runs the provisioning workflows for
the selected apps. After cloning, lazyit tells you what carried over and lists anything that was
skipped (and why). A selected asset or application that has since been **deleted** is skipped rather
than copied, so the clone never revives a retired asset or a decommissioned application.

## Reset a password

On a user's detail page, **Reset password** starts a password reset for that person. It exists only
with **local accounts**, where lazyit owns passwords. With your own OIDC provider the action does not
appear: the provider owns the credential, so reset it there.

You choose how the reset reaches the person:

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

When someone leaves, open them and choose **Offboard** from the **⋯** menu. A wide panel opens with the full
impact up front: four tiles count the **assets released**, the **access revoked**, the **consumables still
out** and the **account archived** (its history is kept). Below them, the left column lists what happens on
confirm — the assets to return, the application access to revoke (with its access level, and a
**Critical** mark on critical applications) and the consumables delivered — and the right column holds the
optional handover act. On confirm, lazyit:

- **revokes** the person's active application access,
- **removes** the person's access to every [Secret vault](/help/secret-manager-vaults-members) they
  belonged to (their cryptographic membership is dropped),
- **releases** the assets they hold,
- **archives** the user (a soft delete) so they can no longer be assigned assets.

It all happens together: if any step fails, the whole offboarding is rolled back, so a departing person
is never left half-offboarded (archived but still holding access).

**They are signed out everywhere.** On an instance with **local accounts**, offboarding ends the person's
sessions on every device at once — including one where they ticked **Keep me signed in**. Deactivating
someone (clearing **Active** when you edit them) does the same.

**With your own OIDC provider, disable them there too.** lazyit does not touch the person's account in
your provider. If they have signed in to lazyit before, their next sign-in is refused; someone
offboarded before their first sign-in, though, would get a fresh Viewer account when they sign in.
Disabling the account in the provider is what actually ends access — make it part of the same leaver
process.

**Rotate the secrets they could read.** If the person was a member of any Secret vault, the confirmation
lists those vaults (with how many secrets each holds) as a reminder to **rotate those secrets by hand**.
Removing their membership stops any *new* reads, but because they could already read those vaults, the
values themselves should be changed. lazyit **cannot rotate them for you** — it is zero-knowledge and
never sees the plaintext, so it can't re-encrypt on your behalf. This is a prompt, not an automatic
action. (Who removed whose vault access, and when, is recorded in the Secret Manager's audit trail.)

**Nothing is destroyed.** The person and their history are preserved for the record — the panel's footer
says so, and the button names the person you are offboarding. Offboarding is valid even when the person
holds nothing — it still stands as a record of their departure.

**The handover act.** The right column shows a live preview of the printed **return act**: the company
name and date, the person, the sections it will list, your handover note and the two signature lines
(Employee and IT). It updates as you change the settings. Open **Customize act** to set the company name,
edit the handover note (saved as a template that pre-fills every act) and choose what the act lists with
the **Assets**, **Access** and **Consumables** chips. These settings are kept for next time. Choose
**Print act** to open the act in a new tab and sign it on paper at hand-off.

If the panel can't load the person's assets, access or consumables, it says so instead of showing empty
lists, the tiles show "—", and the act can't be printed until you **Retry** and it loads.

**Consumables they received.** The offboarding sheet also lists the
[consumables delivered](/help/consumables-stock-movements) to the person, in two groups:

- **Consumables to return** — returnable items still outstanding (a loaner headset, a spare charger),
  with how many units are still out. These are what to ask back.
- **Consumables delivered** — items that were handed out for good (toner, cables), listed for the
  record.

Offboarding **does not move stock** and closes no delivery: record each return from the person's page
as the item comes back. By default everything listed is printed on the return act. Untick a row to
leave it off, or turn off the **Consumables** chip under **Customize act** to leave the whole section off;
the act then prints exactly what you kept. If the person received more than the sheet can list, it says
how many more there are rather than leaving them out silently.

## Consumables on a person's page

A person's page has a **Consumables** tab listing what was delivered to them, newest
first. **Outstanding only** shows just the returnable items still out, and a date filter narrows it by
when they were delivered. With permission to record stock movements you can **Deliver consumable** to
them or record a **Return…** from here. People who cannot view other users do not see this tab.

## Find users by role

The Users list has a **role filter** alongside the status and directory filters: pick **Admin**,
**Member** or **Viewer** to show only people who hold that role. It is server-side, so it stays
accurate at any team size, and the choice lives in the page address — a filtered list is shareable and
bookmarkable. The [Roles](/help/users-permissions-roles) screen's **View N members** links land here
pre-filtered, so the Users list is the one place you browse and manage role membership.

## Directory people

A **directory** person is a User without a login — created by the [bulk
import](/help/assets-bulk-import) as an asset's "assigned to", with no sign-in account. They give an
asset an owner on record before that owner can sign in.

- **In the Users list** a directory person carries a **Directory** badge next to their name, and the
  **directory filter** (next to the status filter) narrows the list to *Directory only*, *Accounts
  only*, or everyone.
- **With your own OIDC provider, they link to a real account on first sign-in**, when the verified
  email matches — at which point the badge disappears and they become a normal account. A directory
  person imported **without a real email never links automatically**.
- **Give them an account now.** What a directory person's page offers depends on how your instance signs
  people in:
  - **Local accounts** — an admin-only (Manage users) action, **Onboard with a temporary password**,
    creates their login right here and shows a **one-time temporary password** to hand off. The password
    is shown **only once** (copy it then), the person **must change it at first sign-in**, and
    onboarding **keeps their existing role** — it never grants extra access. No email is required.
  - **Your own OIDC provider** — lazyit cannot create accounts in your provider, so a short note takes
    the action's place: create the person there with the same verified email, and their first sign-in
    links the account to this record.

## Restore a user

Offboarded users are archived, not deleted. To bring one back, show archived users in the Users list
and choose **Restore**. Restoring is admin-only.

Restoring — or reactivating someone you deactivated — never brings back an old session: on an instance
with **local accounts**, the person must sign in again.

> Offboarding (and any deactivation) frees the resources a person held but keeps the full history —
> who held which asset and when, and what access they had — because lazyit is built so that people
> rotate while the record persists.

See [Roles](/help/users-permissions-roles) for assigning access levels and
[Permissions](/help/permissions) for what each role can do.
