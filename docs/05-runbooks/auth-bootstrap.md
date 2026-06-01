---
title: Zitadel Auth Bootstrap
tags: [runbook, auth, zitadel, oidc]
status: accepted
created: 2026-05-26
updated: 2026-05-26
---

# Runbook — Zitadel IdP bootstrap (auth Phase 1)

Step-by-step procedure for an IT generalist to start Zitadel, create the first admin,
and register lazyit as an OIDC client. Written for the self-hosted prod setup.
See [[0037-idp-choice-zitadel-byoi]] for the rationale behind Zitadel and BYOI design.

> [!info] BYOI — Bring Your Own IdP
> This runbook covers the **bundled Zitadel** setup. If you already have an OIDC-compatible
> IdP (Azure AD, Okta, Keycloak, Authentik …), skip directly to
> [[#7 — Bring-your-own-IdP (BYOI)]]. No code changes are needed — you just set 3 env vars.

---

## 1 — Prerequisites

Before starting:

1. **DNS record.** Create an A (or AAAA) record for `auth.yourdomain.com` pointing to your
   server's public IP. Let's Encrypt needs this to be reachable on port 80 before issuing a
   certificate. On a private network, skip this and use Caddy's internal CA instead (set
   `LAZYIT_DOMAIN=localhost`).

2. **Environment file.** Copy and fill in the prod env template:
   ```sh
   cp infra/env/.env.prod.example infra/env/.env.prod
   chmod 600 infra/env/.env.prod
   ```
   Set every `CHANGE_ME` value. Critical Zitadel vars:
   - `ZITADEL_DB_PASSWORD` — strong, unique, random.
   - `ZITADEL_MASTERKEY` — **minimum 32 characters**, random. Generate one:
     ```sh
     openssl rand -base64 32
     ```
     This key encrypts Zitadel's sensitive data at rest. **Back it up.** Losing it means
     losing access to Zitadel's encrypted data.
   - `ZITADEL_EXTERNALDOMAIN` — the auth subdomain without protocol, e.g. `auth.yourdomain.com`.
   - `LAZYIT_DOMAIN` — your base FQDN, e.g. `yourdomain.com` (Caddy builds `auth.yourdomain.com`
     from this).
   - `ZITADEL_ADMIN_PASSWORD` — must meet Zitadel's complexity: min 8 chars, uppercase,
     lowercase, digit, and symbol (e.g. `MySecur3!Pass`).

3. **Caddy TLS email (optional for real domains).** If you want publicly-trusted certificates,
   uncomment `email {$LAZYIT_TLS_EMAIL}` in `infra/caddy/Caddyfile` and set `LAZYIT_TLS_EMAIL`
   in `.env.prod`.

---

## 2 — First start

Start only Zitadel and its database first (the full stack can come up after bootstrap):

```sh
# From the repo root:
docker compose -f infra/docker-compose.prod.yml up -d zitadel_db zitadel caddy
```

Watch the logs — the first start takes **30–90 seconds** because Zitadel initialises its
database schema and creates the first admin user:

```sh
docker compose -f infra/docker-compose.prod.yml logs -f zitadel
```

Wait until you see a line similar to:

```
server is listening on :8080
```

At this point Zitadel is ready and the admin user has been created with the credentials from
`ZITADEL_ADMIN_USERNAME` and `ZITADEL_ADMIN_PASSWORD`.

> [!warning] start-from-init is safe to re-run
> Zitadel uses `start-from-init`: it applies the DB schema if not present, and skips the
> first-instance setup if it already exists. Restarting the container is safe.

---

## 3 — Access the Zitadel console

Open your browser and go to:

```
https://auth.yourdomain.com/ui/console
```

For local prod-like (with `LAZYIT_DOMAIN=localhost`):

```
https://auth.localhost:8443/ui/console
```

Log in with the `ZITADEL_ADMIN_USERNAME` and `ZITADEL_ADMIN_PASSWORD` values from `.env.prod`.
You may be prompted to change the password on first login — use a strong password and record it
securely.

---

## 4 — Register the lazyit OIDC client

Zitadel organises clients as **Applications** inside a **Project**. Do this once after bootstrap.

### 4a. Create a project

1. In the left sidebar, click **Projects**.
2. Click **Create new project**.
3. Name it `lazyit`. Leave the defaults and click **Create**.

### 4b. Create the application

1. Inside the `lazyit` project, click **Applications**.
2. Click **New application**.
3. Name it `lazyit-web`. Click **Continue**.
4. Select application type: **Web**. Click **Continue**.
5. Select authentication method: **Code** (Authorization Code flow with client secret — correct
   for a server-side Next.js / NestJS backend). Click **Continue**.
6. Set the redirect URI (the Auth.js callback URL). The path is `/api/auth/callback/<provider-id>`
   and lazyit's provider id is **`oidc`** (see `apps/web/auth.ts`):
   ```
   https://yourdomain.com/api/auth/callback/oidc
   ```
   For local prod-like:
   ```
   https://localhost:8443/api/auth/callback/oidc
   ```
   Click **Add** then **Continue**.
7. Review the summary and click **Create**.

### 4c. Configure token settings (REQUIRED — the app does not work without this)

Open the `lazyit-web` application → **Token Settings** and set:

1. **Auth Token Type → `JWT`** (default is `Bearer Token`, which is **opaque**). The lazyit API
   validates the access token as a JWT against Zitadel's JWKS (ADR-0038). An opaque token cannot
   be verified and every API call returns `401`. This must be **JWT**.
2. **User Info inside ID Token → enabled.** By default Zitadel keeps profile claims (name, email)
   in the userinfo endpoint only, so the ID token carries just `sub` and the app shows an empty
   user. Enabling this asserts the profile/email claims into the ID token so Auth.js populates the
   session user.

Click **Save**. If users were already signed in, they must sign out and back in to receive
freshly-shaped tokens.

### 4d. Copy the credentials

After creation, Zitadel shows the **Client ID** and **Client Secret** exactly once.
Copy both values immediately — the client secret is not shown again.

Set them in `infra/env/.env.prod`:
```
OIDC_CLIENT_ID=<paste Client ID here>
OIDC_CLIENT_SECRET=<paste Client Secret here>
```

`OIDC_ISSUER` should already be set to `https://auth.yourdomain.com` (no trailing slash).
Verify it matches your `ZITADEL_EXTERNALDOMAIN`.

---

## 5 — Bring up the full stack

With the OIDC credentials now in `.env.prod`, start the remaining services:

```sh
docker compose -f infra/docker-compose.prod.yml up -d --build
docker compose -f infra/docker-compose.prod.yml ps   # verify all services are healthy
```

The API will read `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET` on start.
OIDC token validation is active once the auth integration is wired in the application code
(Phase 2 of the auth epic).

---

## 6 — Add users to Zitadel

All users who need to log into lazyit must have a Zitadel account:

1. In the Zitadel console, click **Users** in the left sidebar.
2. Click **New user**.
3. Fill in: **First name**, **Last name**, **Email**. Set **Username** (used for login).
4. Set an initial password, or tick **Send initialization email** if email is configured.
5. Click **Create**.

On first login via the lazyit app, the backend creates (or updates) a `User` row in the app
database using the OIDC claims (`sub` → `User.externalId`, `email`, `name`). The domain user
record is auto-provisioned — no separate "add user to lazyit" step is needed beyond Zitadel.

> [!tip] Existing lazyit users
> If you already have `User` rows in the app DB (created before auth), link them by setting
> `User.externalId` to the Zitadel `sub` (shown in the Zitadel user detail page). This is a
> one-time manual step; once linked, login works normally.

---

## 6b — Designate the first ADMIN (RBAC bootstrap)

> [!warning] Why this step exists
> RBAC ([[0040-rbac-roles]]) makes the **first user ever provisioned** an `ADMIN` and everyone else
> a `MEMBER`. But the `rbac_user_role` migration backfilled every **pre-existing** user to `MEMBER`,
> and the first-user-ADMIN rule **only fires on a truly empty database**. So on an instance that
> already had users (the common upgrade case), the *only* `ADMIN` is the seeded `admin@lazyit.local`,
> and an operator who signs in via OIDC lands as `MEMBER` with **no UI to promote themselves**.
> You must grant the first real `ADMIN` out-of-band, once. After that, admins manage every role from
> the Users section.

**Preferred — the `set-role` script.** Run it on the API host (or `docker compose exec api`), from
`apps/api`. It validates the role enum, matches the email case-insensitively, targets only LIVE
(non-soft-deleted) users, and prints a loud before→after summary:

```sh
# From apps/api (Bun auto-loads .env for DATABASE_URL):
bun run set-role operator@yourco.com ADMIN

# Demote a stale admin once a real one exists:
bun run set-role old.admin@yourco.com MEMBER
```

Inside the prod Docker stack the API runs as the `api` service:

```sh
docker compose -f infra/docker-compose.prod.yml exec api \
  bun run set-role operator@yourco.com ADMIN
```

The user must already exist in the app DB — it is created automatically on their first OIDC login
(JIT, [[0038-jit-user-provisioning]]), so have them sign in once first, then run the command.

**Fallback — raw SQL.** If you cannot run the script (e.g. you only have `psql`), update the column
directly. `role` is a Postgres enum and `email` is `citext`, so a case-insensitive match works:

```sql
UPDATE users
SET role = 'ADMIN'
WHERE email = 'operator@yourco.com'
  AND "deletedAt" IS NULL;
```

Inside the prod stack (the `db` container already has `POSTGRES_USER` / `POSTGRES_DB` in its env, so
let them expand **inside** the container via `sh -c`):

```sh
docker compose -f infra/docker-compose.prod.yml exec db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "UPDATE users SET role='\''ADMIN'\'' WHERE email='\''operator@yourco.com'\'' AND \"deletedAt\" IS NULL;"'
```

Valid roles are `ADMIN`, `MEMBER`, `VIEWER`. Once at least one real `ADMIN` exists, all further role
management happens in the lazyit UI (**Users** section → the **Role** control). The API refuses to
remove the last administrator (409) and never lets a user change their own role (403), so you cannot
accidentally lock yourself out from the UI.

---

## 7 — Bring-your-own-IdP (BYOI)

Zitadel is the **default bundled IdP**, but the lazyit backend speaks **standard OIDC** — it
does not use any Zitadel-specific APIs. Swapping to a different IdP requires only 3 env var
changes in `infra/env/.env.prod`:

```
OIDC_ISSUER=https://your-other-idp.example.com/path/to/issuer
OIDC_CLIENT_ID=<client id from your IdP>
OIDC_CLIENT_SECRET=<client secret from your IdP>
```

Then restart the affected services:

```sh
docker compose -f infra/docker-compose.prod.yml up -d api
```

No code changes needed. Configure the redirect URI in your IdP to:
```
https://yourdomain.com/api/auth/callback/<provider-name>
```

To remove the bundled Zitadel entirely (clean removal path):

```sh
# Stop and remove Zitadel containers
docker compose -f infra/docker-compose.prod.yml stop zitadel zitadel_db
docker compose -f infra/docker-compose.prod.yml rm -f zitadel zitadel_db

# Remove the Zitadel DB volume (destructive — all Zitadel data gone)
docker volume rm lazyit-prod_zitadel_db_data
```

The app database (`db_data`) is completely unaffected.

---

## Troubleshooting

**Zitadel fails to start — "masterkey must be at least 32 bytes"**
The `ZITADEL_MASTERKEY` is too short. Generate a new one with `openssl rand -base64 32`
and update `.env.prod`.

**Zitadel fails to start — DB connection refused**
Check that `zitadel_db` is healthy before `zitadel` starts:
```sh
docker compose -f infra/docker-compose.prod.yml ps zitadel_db
```
The `depends_on: condition: service_healthy` should handle this, but if the healthcheck
timing is tight, restart Zitadel: `docker compose -f infra/docker-compose.prod.yml restart zitadel`

**"invalid_client" on OIDC callback**
Double-check `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` match the values in the Zitadel
console. The client secret is shown only once at creation time.

**HTTPS certificate error for auth subdomain**
Verify the DNS A record for `auth.yourdomain.com` is correct and reachable on port 80
(for Let's Encrypt). Check Caddy logs:
```sh
docker compose -f infra/docker-compose.prod.yml logs caddy
```

**Admin password rejected on first login**
Zitadel requires min 8 chars, uppercase, lowercase, digit, and symbol. Reset by stopping
the stack, removing the `zitadel_db_data` volume, updating `ZITADEL_ADMIN_PASSWORD` in
`.env.prod`, and running `start-from-init` again. Only do this on a fresh (unpopulated)
instance.

---

Related: [[0037-idp-choice-zitadel-byoi]] · [[deploy-self-hosted]] · [[0028-secrets-and-config]] ·
[[0016-auth-strategy-deferred]] · [[0026-reverse-proxy-tls]]
