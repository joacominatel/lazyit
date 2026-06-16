---
title: Getting started
order: 1
section: Getting started
---

# Getting started

Welcome to lazyit — a self-hosted inventory and access tool for small IT teams. This page walks
you through the very first run: choosing how people sign in, creating the first administrator, and
adding your team.

> This Manual is the product's own documentation, shipped with the code and served from a public,
> login-free page. It is separate from the Knowledge Base: the Manual documents *lazyit itself*, the
> Knowledge Base documents *your estate*.

## Before you start

lazyit does not store login passwords itself. Sign-in is delegated to an **identity provider (IdP)**
that speaks OIDC. You have two options, and you choose between them on the first run:

- **Bundled sign-in** — lazyit ships with a sign-in service (Zitadel) already wired up. This is the
  happy path: nothing extra to configure, and you set the first administrator's password during
  setup.
- **Bring your own provider (BYOI)** — connect lazyit to your existing OIDC identity provider
  (for example your company's SSO). lazyit reads three environment variables to find it:

  ```
  AUTH_ISSUER=https://auth.example.com
  AUTH_CLIENT_ID=your-client-id
  AUTH_CLIENT_SECRET=your-client-secret
  ```

  With your own provider, that provider owns passwords and account creation — lazyit never sets or
  stores a sign-in password.

## The setup wizard

The first time you open a fresh instance, lazyit shows a short, full-screen **setup wizard**. The
wizard runs **once**: as soon as an administrator exists, the instance is configured and the wizard
sends you to the sign-in page instead. The steps adapt to the sign-in option you pick.

### Step 1 — Welcome and sign-in choice

Pick how people will sign in: **bundled sign-in** or **bring your own provider**. The choice is
shown as two cards; select one to continue. Choosing *bring your own provider* reveals the three
environment variables above so you can confirm they are set.

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

- With the **bundled sign-in**, you also set an **initial password** here, with a live checklist of
  the password rules. lazyit sets that password on the bundled sign-in service so the new admin can
  sign in. The new admin is prompted to choose their own password at first sign-in.
- With **your own provider**, no password is asked for or sent — your provider owns the credential.

### Step 4 — Done

The wizard confirms the administrator was created and sends you to the **sign-in page**. The new
account does not have a session yet — sign in as that administrator to get started. Once you are
signed in, the administrator controls appear.

## Adding the rest of your team

After setup, an administrator adds team members from the **Users** area. Use **New user** to open the
full onboarding form, which captures:

- **Identity** — email, first and last name, and optional fields such as username and manager.
- **Sign-in credential** — with the **bundled sign-in**, you set a one-time **temporary password**
  to hand to the new person; they choose their own at first sign-in. lazyit never stores it — it is
  set on the sign-in service and replaced when the user signs in. With **your own provider**, this is
  hidden; your provider owns the credential.
- **Head start (optional)** — you can assign an asset or grant application access to the new person
  right from the creation form.

After you create the user, lazyit shows the temporary password **once** so you can hand it off — it
is not shown again.

> If a person signs in through your identity provider before they are added in lazyit, lazyit can
> provision their account automatically on that first sign-in and link it to a matching record by
> verified email.

## What's next

- **Permissions** — see [Permissions](/help/permissions) for who can do what, and how to tune what
  members and viewers may do.
- **Secret Manager** — see [Secret Manager](/help/secret-manager) for the shared, end-to-end
  encrypted vaults and how recovery keys work.
