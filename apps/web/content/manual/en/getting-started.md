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

## From zero to /setup

Don't have lazyit running yet? On a Linux host with Docker, two commands get you a running instance:

```sh
git clone https://github.com/joacominatel/lazyit && cd lazyit
./infra/start.sh
```

`start.sh` is a guided, idempotent script: it detects Docker, free ports and host resources, asks
around six questions it can't safely default (domain, TLS, identity provider, and so on), generates
`infra/env/.env.prod` with real random secrets, brings the stack up with Docker Compose, and prints
your URL. It is safe to re-run — it is non-destructive and never overwrites existing secrets.

When it finishes, open **`https://<your-host>/setup`** — the rest of this page walks through that
wizard.

For advanced setups (your own OIDC identity provider, an external Postgres, TLS on a real domain),
see [Self-hosting](/help/deployment-operations-self-hosting). To upgrade an existing instance later,
run `./infra/update.sh`.

## Before you start

How people sign in is chosen **once, at deploy time**, and is fixed for the life of the instance. There
are two families:

- **Local accounts** (`AUTH_MODE=local`, the default) — lazyit owns sign-in itself. Each person has a
  username/email and a password stored in the app (as a hash). There is **no** external identity
  provider and nothing extra to run — the simplest way to stand up lazyit. You create the first
  administrator (with a password) during setup.
- **Your own OIDC provider** (`AUTH_MODE=oidc`) — lazyit does not store passwords; sign-in is delegated
  to an **identity provider (IdP)** you already run, such as your company's SSO. lazyit finds it through
  a handful of environment variables, which the guided installer asks for and the setup wizard shows
  again:

  ```
  # Web app
  AUTH_ISSUER=https://auth.example.com
  AUTH_CLIENT_ID=your-client-id
  AUTH_CLIENT_SECRET=your-client-secret

  # API
  AUTH_MODE=oidc
  OIDC_ISSUER=https://auth.example.com
  OIDC_CLIENT_ID=your-client-id
  OIDC_JWKS_URI=https://auth.example.com/.well-known/jwks.json
  ```

  Your provider owns passwords and sign-in; users and roles stay in lazyit.

> **The auth mode is immutable.** Switching an instance between local and OIDC after it has users is
> unsupported (their credentials don't carry across). Decide up front. For the deploy-side detail see
> [Identity provider](/help/deployment-operations-identity-provider).

## The setup wizard

The first time you open a fresh instance, lazyit shows a short, full-screen **setup wizard**. The
wizard runs **once**: as soon as an administrator exists, the instance is configured and the wizard
sends you to the sign-in page instead. The steps adapt to how the instance was deployed.

### Step 1 — Welcome

There is nothing to choose here — the sign-in mode is fixed at deploy time. A card explains it:

- In a **local-accounts** instance, it confirms you're setting up lazyit's built-in accounts.
- In an **OIDC** instance, it names your own OIDC provider and shows the environment variables above,
  with a copy button, so you can check they are set on the web app and the API.

### Step 2 — Configure (OIDC only)

In a local-accounts instance this step is skipped.

In an OIDC instance, this step shows the environment variables once more and asks you to confirm your
provider is wired before you create the first administrator. The administrator's email **must already
exist in your provider**, verified, for them to be able to sign in: on that first sign-in lazyit links
the two by email.

### Step 3 — Create the first administrator

Enter the first administrator's **first name, last name and email**. The role is fixed to
**Administrator** — this step exists only to create the very first admin, so the role is shown as a
locked badge, not an editable field.

- With **local accounts**, you also set an **initial password** here, with a live checklist of the
  password rules. lazyit stores it (as a hash), the new admin can sign in straight away, and this first
  administrator is not forced to change it at first sign-in (that forced change applies to the team
  members you add later).
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
