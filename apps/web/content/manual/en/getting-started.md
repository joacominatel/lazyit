---
title: Initial setup
order: 1
category: getting-started
subcategory: initial-setup
---

# Initial setup

This page walks you through the very first run of a fresh lazyit instance: choosing how people sign
in, creating the first administrator, and adding your team. New to lazyit? Read
[Introduction](/help/getting-started-introduction) first.

> This Manual is the product's own documentation, shipped with the code and served from a public,
> login-free page. It is separate from the Knowledge Base: the Manual documents *lazyit itself*, the
> Knowledge Base documents *your estate*.

## Before you start

How people sign in is chosen **once, at deploy time**, and is fixed for the life of the instance. There
are two families:

- **Local accounts** (`AUTH_MODE=local`) — lazyit owns sign-in itself. Each person has a username/email
  and a password stored in the app. There is **no** external identity provider, no `auth.` subdomain and
  nothing extra to run — the simplest way to stand up lazyit on a LAN. You create the first
  administrator (with a password) during setup.
- **Single sign-on (OIDC)** — lazyit does not store passwords; sign-in is delegated to an **identity
  provider (IdP)**. Within this family you pick one of two on the first run:
  - **Bundled sign-in** — lazyit ships with a sign-in service (Zitadel) already wired up. Nothing extra
    to configure, and you set the first administrator's password during setup.
  - **Bring your own provider (BYOI)** — connect lazyit to your existing OIDC provider (for example your
    company's SSO). lazyit reads three environment variables to find it:

    ```
    AUTH_ISSUER=https://auth.example.com
    AUTH_CLIENT_ID=your-client-id
    AUTH_CLIENT_SECRET=your-client-secret
    ```

    With your own provider, that provider owns passwords and account creation — lazyit never sets or
    stores a sign-in password.

> **The auth mode is immutable.** Switching an instance between local and OIDC after it has users is
> unsupported (their credentials don't carry across). Decide up front. For the deploy-side detail see
> [Identity provider](/help/deployment-operations-identity-provider).

## The setup wizard

The first time you open a fresh instance, lazyit shows a short, full-screen **setup wizard**. The
wizard runs **once**: as soon as an administrator exists, the instance is configured and the wizard
sends you to the sign-in page instead. The steps adapt to the sign-in option you pick.

### Step 1 — Welcome and sign-in choice

In an **OIDC** instance, pick how people will sign in: **bundled sign-in** or **bring your own
provider**. The choice is shown as two cards; select one to continue. Choosing *bring your own
provider* reveals the three environment variables above so you can confirm they are set.

In a **local-accounts** instance there is nothing to choose here — the mode is fixed at deploy time.
The step simply confirms you're setting up local accounts and takes you straight to creating the first
administrator.

### Step 2 — Configure (only for bring-your-own-provider)

If you chose the bundled sign-in, this step is skipped — the bundled service is already provisioned,
so there is nothing to enter. (It may still be finishing its own start-up the very first time; that
is normal.)

If you chose your own provider, this step re-shows the three environment variables so you can confirm
them before you create the first administrator. The administrator's email **must already exist in
your provider** for them to be able to sign in.

### Step 3 — Create the first administrator

Enter the first administrator's **first name, last name and email**. The role is fixed to
**Administrator** — this step exists only to create the very first admin, so the role is shown as a
locked badge, not an editable field.

- With **local accounts** or the **bundled sign-in**, you also set an **initial password** here, with a
  live checklist of the password rules. For local accounts lazyit stores that password itself; for the
  bundled sign-in it sets the password on the sign-in service. Either way the new admin can sign in
  straight away, and this first administrator is not forced to change it at first sign-in (that forced
  change applies to the team members you add later).
- With **your own OIDC provider**, no password is asked for or sent — your provider owns the credential.

### Step 4 — Done

The wizard confirms the administrator was created and sends you to the **sign-in page**. The new
account does not have a session yet — sign in as that administrator to get started. In a local-accounts
instance you sign in with the email/username and password you just set; in an OIDC instance you sign in
through your provider. Once you are signed in, the administrator controls appear.

> **If your session expires**, lazyit returns you to the sign-in page so you can sign in again —
> just sign back in to pick up where you left off.

## What's next

- **Add your team** — once you are signed in as the administrator, see
  [Users & team](/help/getting-started-users-team) to add people, hand off temporary passwords, and
  understand what happens on first sign-in.
- **Switch language** — lazyit ships in English and Spanish; see
  [Languages](/help/getting-started-languages) to change it.
- **Permissions** — see [Permissions](/help/permissions) for who can do what, and how to tune what
  members and viewers may do.
- **Secret Manager** — see [Secret Manager](/help/secret-manager) for the shared, end-to-end
  encrypted vaults and how recovery keys work.
