---
title: Identity provider
order: 4
category: deployment-operations
subcategory: identity-provider
---

# Identity provider

lazyit offers two ways to sign in, chosen **once at deploy time** via `AUTH_MODE` and then
**immutable** for the life of the instance:

- **Local accounts** (`AUTH_MODE=local`, the default) — lazyit owns sign-in itself (username/email +
  password), with **no external identity provider**. This is the simplest option and the one the guided
  installer picks unless you choose otherwise.
- **Your own OIDC provider** (`AUTH_MODE=oidc`) — sign-in is delegated to an **identity provider you
  already run** that speaks **OIDC**: Entra ID, Okta, Keycloak, Authentik and similar.
  lazyit stores no sign-in password in this mode.

Switching an instance between the two on a populated database is unsupported — credentials don't carry
across. Decide up front.

> For the end-user side of this choice (the first-run wizard, adding team members), see
> [Getting started](/help/getting-started).

## Local accounts (default)

With `AUTH_MODE=local`, lazyit runs with **no external identity provider at all** — no OIDC issuer, no
extra service to run. lazyit stores each person's credential itself (passwords are hashed with
**argon2id**) and issues its own signed session on login. This is the standard self-hosted pattern
(Gitea, Portainer, Proxmox) and the least moving parts for a small internal deploy.

- **First run.** The setup wizard confirms you are setting up local accounts and goes straight to
  creating the first administrator with a **name, email and password**. That password is stored (hashed)
  as the admin's credential.
- **Sign-in page.** `/login` shows a **username/email + password** form.
- **Adding people.** An administrator creates each user with a temporary password directly in lazyit;
  there is no automatic account creation on first sign-in (that is an OIDC-only behavior).
- **The signing secret.** Local mode requires a persistent `SESSION_SIGNING_SECRET` (generated for you
  by the guided installer). It is separate from `AUTH_SECRET`. Rotating it only forces everyone to sign
  in again — no data loss — but keep it stable so restarts don't sign everyone out.
- **No MFA yet.** Local mode is password-only in this version; multi-factor is available only through
  an OIDC provider that offers it. If you need MFA today, connect your own provider.
- **Lost the last admin password?** A one-shot **recovery command** (run on the host) resets a named
  administrator's password directly. See [Troubleshooting](/help/deployment-operations-troubleshooting).

> **Local mode and the Secret Manager.** The Secret Manager stays end-to-end encrypted: your login
> password is **not** your vault passphrase. They are separate credentials by design — do not reuse one
> as the other. See [Secret Manager](/help/secret-manager).

## Your own OIDC provider

If you already run an OIDC-compatible identity provider, connect lazyit to it. The backend speaks
**standard OIDC** and uses no provider-specific APIs, so this needs **no code changes** — only
environment variables.

1. **Register lazyit in your provider** as an OIDC application (a confidential web client). Note its
   **issuer URL**, **client ID** and **client secret**, and the **`jwks_uri`** listed in the provider's
   discovery document (`<issuer>/.well-known/openid-configuration`).
2. **Set the redirect URI** in your provider to your instance's callback URL:
   `https://yourdomain.com/api/auth/callback/oidc`.
3. **Give lazyit the values.** The guided installer (`./infra/start.sh`) asks for them when you choose
   *your own OIDC provider* at the authentication question and writes them for you. To set them by hand,
   put these in `infra/env/.env.prod` — the web app reads the first three, the API the rest:

   ```sh
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

   `OIDC_ISSUER` and `OIDC_JWKS_URI` are **required** — the API refuses to start in OIDC mode without
   them. If your provider runs on the same host and its public address doesn't resolve from inside the
   containers, also set `AUTH_INTERNAL_ISSUER` to an address the web app can reach.
4. **Recreate the web app and the API**, then open `/setup`. The wizard shows the same variables so you
   can check them before you create the first administrator.

The plain-HTTP **LAN mode** of the installer works with local accounts only: an OIDC redirect URI is
registered against one fixed address, so it can't follow a changing IP.

### What your provider owns

With your own provider, the provider is the source of truth for **credentials**, and lazyit stays out
of its way:

- **Passwords, multi-factor, lockout and sessions** live in your provider — configure them there.
  lazyit never sees, sets or stores a sign-in password, and the administrator's **Reset password**
  action does not appear.
- **People are created in both places.** Add the person in lazyit (**Users → New user**) and in your
  provider with the **same email**. On their first sign-in, lazyit links the two by **verified email**.
  Someone who can sign in to your provider but isn't in lazyit yet gets a new **Viewer** account on that
  first sign-in.
- **lazyit never writes to your provider.** Name, email and role changes made in lazyit stay in lazyit,
  and lazyit can't create an account in your provider for you.
- **Disabling the account in your provider is what ends access.** Offboarding someone in lazyit
  leaves their provider account active. If they have signed in to lazyit before, their next sign-in is
  refused; but someone offboarded before their first sign-in would get a fresh Viewer account the
  moment they sign in. Always disable the account in your provider as part of your leaver process.

## Authorization stays in lazyit

Whichever sign-in you use, **what each person can do** is decided entirely inside lazyit. Permissions
and roles are stored in the application database and never touch the identity provider. The identity
provider only answers "who is this person"; lazyit answers "what may they do." See
[Permissions](/help/permissions).

## Related

- [Self-hosting](/help/deployment-operations-self-hosting)
- [Services](/help/deployment-operations-services)
- [Reverse proxy & TLS](/help/deployment-operations-reverse-proxy-tls)
- [Getting started](/help/getting-started)
- [Permissions](/help/permissions)
