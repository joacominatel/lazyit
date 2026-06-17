---
title: Users & team
order: 1
category: getting-started
subcategory: users-team
---

# Users & team

Once you are signed in as an administrator, you add the rest of your team from the **Users** area.
Each person gets a lazyit account with a role, and — on the bundled sign-in — a one-time password you
hand off so they can sign in.

## Adding a user

Open **Users** and choose **New user** to open the onboarding form. It has three parts:

- **Identity** — first name, last name, and email are required. Email is the person's identity, so it
  must be unique. Optional fields let you record a username, an employee ID, and a manager.
- **Role** — pick **Admin**, **Member**, or **Viewer**. New users default to **Viewer** (read-only)
  — least privilege by default. Admins have full access including user administration; Members do
  normal inventory, Knowledge Base, and asset operations; Viewers are read-only everywhere. You can
  change a role later. See [Permissions](/help/permissions) for the full breakdown.
- **Head start (optional)** — you can assign one asset and/or grant access to one application right
  from the form, so the person starts with something in hand. You can always do this later instead.

Select **Create user** to finish.

## The temporary password hand-off

On the **bundled sign-in**, the form includes a **Sign-in credential** section where you set a
**temporary password**. Use **Generate** to produce a strong one (it must meet the live checklist:
length, plus an uppercase letter, a lowercase letter, a number, and a symbol).

After you create the user, lazyit shows the temporary password **once** so you can copy and hand it
off — it is not shown again, so capture it before you leave the screen. lazyit never stores this
password: it is set on the sign-in service, and it is replaced the moment the new user signs in,
because they are **required to choose their own password at first sign-in**.

> If your instance uses **your own identity provider** (BYOI), the credential section does not appear
> and no password is set or sent — your provider owns the credential. A banner on the Users page
> reminds you that users and roles managed here are *local to lazyit* and are not written back to your
> provider; create and disable accounts in your IdP, and lazyit keeps its own copy for authorization.

## What happens at first sign-in

When a person signs in for the first time, lazyit links the session to their lazyit account and they
land in the app with the role you set.

With **your own identity provider**, lazyit can also provision an account *automatically* on first
sign-in (just-in-time), even if you did not add the person beforehand. If a matching account already
exists by **verified email**, the first sign-in is linked to it instead of creating a duplicate.
Auto-provisioned accounts also start as **Viewer** by default. This means the gate on who can reach
lazyit is your identity provider: whoever can sign in there can get a (read-only) account here unless
you remove their access upstream.

## Managing existing people

From a user's detail page you can edit their identity, change their role, reset their password (on the
bundled sign-in), and offboard them when they leave. Offboarding archives the account rather than
deleting it, so the person's history — past assignments and activity — is preserved.

## Next steps

- Tune who can do what: [Permissions](/help/permissions).
- Set up shared credential vaults: [Secret Manager](/help/secret-manager).
