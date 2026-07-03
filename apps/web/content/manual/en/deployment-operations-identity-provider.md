---
title: Identity provider
order: 4
category: deployment-operations
subcategory: identity-provider
---

# Identity provider

lazyit supports two families of sign-in, chosen **once at deploy time** via `AUTH_MODE` and then
**immutable** for the life of the instance:

- **Local accounts** (`AUTH_MODE=local`) — lazyit owns sign-in itself (username/email + password), with
  **no external identity provider**. This is the simplest option for a LAN or internal deployment; see
  [Local accounts](#option-3--local-accounts-no-identity-provider) below.
- **Single sign-on (OIDC)** — sign-in is delegated to an **identity provider** that speaks **OIDC**,
  either the bundled one or your own (the two options below). lazyit stores no sign-in password in this
  family.

You may still switch between the bundled and your-own OIDC provider (both are OIDC), but switching
between the **local** and **OIDC** families on a populated instance is unsupported — their credentials
don't carry across. Decide the family up front.

> For the end-user side of this choice (the first-run wizard, adding team members), see
> [Getting started](/help/getting-started).

## Option 1 — the bundled identity provider (recommended)

lazyit ships with **Zitadel** already wired up. With the bundled flow, sign-in works out of the box:

- A one-shot bootstrap step provisions the whole OIDC integration at first boot — the project, the
  OIDC application, the roles and a service account — with **no console clicking**. You never copy a
  client id or secret by hand.
- The bundled provider runs as two containers (the provider itself and its own database), reachable at
  the **`auth.` subdomain** of your domain, served over HTTPS by the reverse proxy.
- You set only a handful of values in the environment file: the external auth URL, your domain, the
  master key and a first-boot admin password. The bootstrap supplies the rest.

This is the happy path. The first administrator is created later, in the in-app setup wizard — the
identity-provider bootstrap never creates an application user.

> The identity-provider **master key** is unrotatable and irreplaceable, and it is what makes a
> restored provider database readable. Treat it like a crown jewel and back it up off-host. See
> [Backups & restore](/help/deployment-operations-backups-restore).

## Sign-in appearance & language (bundled provider)

The bootstrap also **brands and localizes the sign-in page** so it matches lazyit and no longer looks
like a stock, third-party screen. On the same first-boot run it automatically:

- Sets the **brand oxblood** accent color and **hides the "Powered by ZITADEL" watermark**.
- Allows both **English and Spanish** and follows the language you're using in the app, so the sign-in
  page appears in the same language.
- Sends new employees straight to the sign-in form instead of a shared account picker, so a brand-new
  person never sees **other people's** accounts on a shared machine.

These are cosmetic touches: if any of them can't be applied at boot they're skipped with a warning in
the logs and sign-in still works.

**Add your logo (one-time, optional).** The logo is the one branding piece the bootstrap does *not*
upload for you. To add it, sign in to the provider's console at the `auth.` subdomain
(`/ui/console`) as the admin, open **Settings → Branding**, upload your light and dark logo (and
favicon), then **Apply configuration**. It persists across restarts.

**First sign-in note.** With the bundled provider, a newly added person's **initial password is
temporary** — the provider asks them to set their own on first sign-in, and may also offer to add a
second factor. The sign-in page shows a short reminder of this. The order in which the provider presents
those steps is fixed by the provider and isn't something lazyit can change.

## Option 2 — bring your own provider (BYOI)

If you already run an OIDC-compatible identity provider — Azure AD / Entra ID, Okta, Keycloak,
Authentik, and similar — connect lazyit to it instead. The backend speaks **standard OIDC** and uses no
provider-specific APIs, so this needs **no code changes**.

To switch:

1. In your provider, register an application and note its **issuer URL**, **client id** and **client
   secret**.
2. In the environment file, set the three OIDC values to point at your provider (issuer, client id,
   client secret), plus the matching sign-in values the web app reads.
3. **Remove the bundled Zitadel services** so the bootstrap doesn't run (the provider, its database and
   the bootstrap helper).
4. Configure the **redirect URI** in your provider to your instance's callback URL, of the shape
   `https://yourdomain.com/api/auth/callback/<provider-name>`.
5. Recreate the affected services.

With your own provider, that provider owns passwords and account creation — lazyit never sets or stores
a sign-in password. The application database is completely unaffected by the switch.

## Option 3 — local accounts (no identity provider)

Set `AUTH_MODE=local` and lazyit runs with **no external identity provider at all** — no Zitadel, no
`auth.` subdomain, no OIDC issuer. lazyit stores each person's credential itself (passwords are hashed
with **argon2id**) and issues its own signed session on login. This is the standard self-hosted pattern
(Gitea, Portainer, Proxmox) and the least moving parts for a small internal deploy.

- **First run.** The setup wizard's sign-in-choice step is skipped; you go straight to creating the
  first administrator with a **name, email and password**. That password is stored (hashed) as the
  admin's credential — there is no IdP to mirror it to.
- **Sign-in page.** Instead of an SSO button, `/login` shows a **username/email + password** form.
- **Adding people.** An administrator provisions each user with a password directly in lazyit; there is
  no automatic provisioning on first sign-in (that is an OIDC-only behavior).
- **The signing secret.** Local mode requires a persistent `SESSION_SIGNING_SECRET` (generated for you
  by the guided installer). It is separate from `AUTH_SECRET`. Rotating it only forces everyone to sign
  in again — no data loss — but keep it stable so restarts don't sign everyone out.
- **No MFA yet.** Local mode is password-only in this version; multi-factor is available only via an
  OIDC provider that offers it. If you need MFA today, choose an OIDC family.
- **Lost the last admin password?** Because there is no IdP to reset it, a one-shot **recovery command**
  (run on the host) resets a named administrator's password directly. See
  [Troubleshooting](/help/deployment-operations-troubleshooting).

> **Local mode and the Secret Manager.** The Secret Manager stays end-to-end encrypted: your login
> password is **not** your vault passphrase. They are separate credentials by design — do not reuse one
> as the other. See [Secret Manager](/help/secret-manager).

## Authorization stays in lazyit

Whichever provider you use, **what each person can do** is decided entirely inside lazyit. Permissions
and roles are stored in the application database and never touch the identity provider, so they carry
across a provider switch unchanged. The identity provider only answers "who is this person"; lazyit
answers "what may they do." See [Permissions](/help/permissions).

A person who signs in through your provider before being added in lazyit can be provisioned
automatically on that first sign-in, matched to a record by verified email.

## Local prod-like note

When you run the full stack on your own machine for testing, the auth subdomain is `auth.localhost`.
Most systems resolve `*.localhost` to your machine automatically; if yours does not, add
`127.0.0.1 auth.localhost` to your hosts file so the browser can reach the sign-in page. The issuer URL
must include the high HTTPS port in that case.

## Related

- [Self-hosting](/help/deployment-operations-self-hosting)
- [Services](/help/deployment-operations-services)
- [Reverse proxy & TLS](/help/deployment-operations-reverse-proxy-tls)
- [Getting started](/help/getting-started)
- [Permissions](/help/permissions)
