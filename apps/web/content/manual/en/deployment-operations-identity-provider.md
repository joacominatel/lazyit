---
title: Identity provider
order: 4
category: deployment-operations
subcategory: identity-provider
---

# Identity provider

lazyit does not store sign-in passwords itself. Sign-in is delegated to an **identity provider** that
speaks **OIDC**. You choose between two options at deploy time, and you can switch later without code
changes.

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
