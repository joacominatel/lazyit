---
title: Zitadel Auth Bootstrap
tags: [runbook, auth, zitadel, oidc]
status: accepted
created: 2026-05-26
updated: 2026-06-01
---

# Runbook — Zitadel IdP bootstrap

How to bring up the bundled Zitadel IdP for the self-hosted prod stack. lazyit ships a
**zero-touch bootstrap** (ADR-0043 Phase 3): `docker compose … --profile prod up` provisions the
whole OIDC integration — project, OIDC app, project roles, runtime service-account — with **NO
Zitadel console access**. The old manual console procedure is kept below as a fallback/teaching aid.
See [[0037-idp-choice-zitadel-byoi]] and [[auth-zitadel-sot]] §4 for the rationale.

> [!tip] Start here — the zero-touch path
> For the **bundled Zitadel** flow, follow [[#0 — Zero-touch bootstrap (recommended)]]. You only set
> a handful of env vars; the `zitadel-bootstrap` sidecar does all the console work and writes the
> OIDC client id/secret into a shared volume the app reads automatically — **you never copy them by
> hand**.

> [!info] BYOI — Bring Your Own IdP
> If you already have an OIDC-compatible IdP (Azure AD, Okta, Keycloak, Authentik …), skip to
> [[#7 — Bring-your-own-IdP (BYOI)]]. No code changes — you set 3 env vars and drop the Zitadel
> services. The manual console sections [[#3 — Access the Zitadel console]]–[[#5 — Bring up the full
> stack]] are retained for operators who prefer to provision Zitadel by hand.

---

## 0 — Zero-touch bootstrap (recommended)

This is the default path for the bundled Zitadel. One command brings up a fully-configured IdP.

### 0a. Fill in the env file

```sh
cp infra/env/.env.prod.example infra/env/.env.prod
chmod 600 infra/env/.env.prod
```

Set every `CHANGE_ME` (passwords, `ZITADEL_MASTERKEY` **exactly 32 bytes** — `openssl rand -hex 16`,
`AUTH_SECRET`, your domain). For
the bundled flow you **leave `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `AUTH_CLIENT_ID` /
`AUTH_CLIENT_SECRET` as `CHANGE_ME`** — the sidecar provisions them. You only need to set the
*external auth URL*: `OIDC_ISSUER` / `AUTH_ISSUER` (e.g. `https://auth.yourdomain.com`),
`ZITADEL_EXTERNALDOMAIN`, `LAZYIT_DOMAIN` and `WEB_ORIGIN`.

### 0b. Bring up the full stack — one command

```sh
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml \
  --profile prod --env-file infra/env/.env.prod up -d --build
```

The boot order is enforced by `depends_on`:

```
zitadel_db (healthy) → zitadel (healthy) → zitadel-bootstrap (completed) → api + web (healthy) → caddy
```

On first boot Zitadel `start-from-init` creates the admin **and** a FirstInstance *machine user*,
exporting its private key to `bootstrap-key.json` in the `zitadel_secrets` volume. The one-shot
`zitadel-bootstrap` sidecar then authenticates with that key (Private-Key JWT) and **idempotently**:

1. creates/finds the `lazyit` **project** (with role assertion on),
2. creates the project **roles** `ADMIN` / `MEMBER` / `VIEWER` (the Phase-2 write-back grants these),
3. creates/finds the OIDC **web app** (redirect = `…/api/auth/callback/oidc`, JWT access token,
   userinfo + roles asserted into the ID token) and captures its **client id + secret**,
4. creates/finds a runtime **service-account** + private key for the API write-back,
5. writes two files into the `zitadel_secrets` volume — `oidc-client.json` (issuer/client_id/
   client_secret/jwks/project id, read by api **and** web) and `sa-key.json` (the runtime SA key,
   read by the API via `ZITADEL_MGMT_SA_KEY_PATH`).

The api and web then **consume** `oidc-client.json` at startup (path = `OIDC_CLIENT_FILE`, default
`/zitadel-secrets/oidc-client.json`): the api back-fills `OIDC_*` + `ZITADEL_MGMT_PROJECT_ID`, the web
maps them onto its `AUTH_*` vars (+ derives `AUTH_INTERNAL_ISSUER` from the file's internal JWKS
origin). Explicit env **always wins**, so in the bundled flow you leave `OIDC_CLIENT_ID/SECRET`,
`AUTH_CLIENT_ID/SECRET` and `ZITADEL_MGMT_PROJECT_ID` **unset** — the sidecar provides them and you
never hand-copy a client id/secret from the console. Set them in `.env.prod` only for BYOI.

### 0c. Watch it provision

```sh
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod \
  --env-file infra/env/.env.prod logs -f zitadel-bootstrap
```

A successful run ends with `DONE — Zitadel is provisioned. project=… app=… sa=…` and **exit 0**.
The sidecar is `restart: "no"` and **fails loud**: any error exits non-zero, `api`/`web` won't start
(their `depends_on` requires `service_completed_successfully`), and the run is visible in
`docker compose ps` as `Exit 1`. Re-running `up` re-runs the sidecar; it is idempotent — if the
secret files already exist it short-circuits with *"already provisioned … nothing to do"*.

> [!warning] Clean re-bootstrap
> `down -v` wipes `zitadel_db_data` (and the admin/instance) but the named `zitadel_secrets` volume
> **also** holds the keys. For a clean re-provision remove **both**:
> ```sh
> docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod down -v
> docker volume rm lazyit-prod_zitadel_secrets   # drops bootstrap-key.json / oidc-client.json / sa-key.json
> ```
> Stale creds in `zitadel_secrets` against a fresh `zitadel_db` will block re-provision (the script
> can't re-read an existing app's secret — it fails loud and tells you to remove the volume).

> [!tip] Secrets-volume ownership (handled automatically)
> The `zitadel_secrets` volume must be writable by Zitadel's non-root uid for the FirstInstance key
> export to land. A one-shot **`zitadel-secrets-init`** service `chmod 0777`s the volume BEFORE Zitadel
> starts (`zitadel.depends_on: zitadel-secrets-init: service_completed_successfully`), so no manual
> `chown`/`chmod` is needed. If `bootstrap-key.json` still never appears, the sidecar exits non-zero
> with a clear *"machine key not found"* message — inspect `docker compose logs zitadel-secrets-init`
> and the volume permissions (dossier §4e). The sidecar writes its `oidc-client.json`/`sa-key.json`
> outputs `0644` so `api`/`web` (a different uid, read-only mount) can read them.

After this, jump to [[#6 — Add users to Zitadel]] (and [[#6b — Designate the first ADMIN (RBAC
bootstrap)]] on an upgraded instance). Sections 1–5 below document the **manual** alternative.

### 0d. DEV — one command (`bun run dev:fresh`)

The prod sidecar above runs **inside** the Docker network. **Dev** runs the apps natively (`bun run
dev` on the host) against the same bundled Zitadel, so the equivalent one-command flow lives in
`scripts/dev-setup.ts` (issue #483) — it **reuses the very same `infra/scripts/zitadel-bootstrap.sh`**,
just invoked on the host against the loopback-published dev Zitadel (`http://localhost:8080`). See
[[setup]] for the day-to-day workflow; this is the auth-specific detail.

```sh
bun run dev:fresh    # wipe dev volumes → up → migrate/generate/seed → bootstrap Zitadel → wire env → start
bun run dev:up       # (every day after) up + a fresh Prisma client → start; assumes dev:fresh ran before
```

`dev:fresh` is **idempotent and fail-loud** (the script mirrors the prod sidecar's discipline). It:

1. **removes the dev volumes** `lazyit_{db_data,zitadel_db_data,zitadel_secrets,meili_data,valkey_data}`
   (the destructive step — it prompts for a typed `yes` unless `--yes` is passed);
2. `docker compose up -d` — the dev **`zitadel-secrets-init-dev`** (in `compose.override.yaml`) chmods
   the `zitadel_secrets` volume `0777` **before** Zitadel starts, so Zitadel's non-root uid can write
   `bootstrap-key.json`. This fixes the #477 dev crash-loop **at the compose level**, so even a plain
   `docker compose up` (without the script) no longer needs a manual `chmod`;
3. waits for `db` healthy + Zitadel `/debug/healthz` 200;
4. `prisma migrate deploy` → **`prisma generate`** (explicit — `migrate deploy` does not regenerate the
   client; a stale client breaks the API boot, #480) → `prisma db seed`;
5. copies `bootstrap-key.json` out of the `zitadel_secrets` volume into a throwaway tmpdir and runs
   **`infra/scripts/zitadel-bootstrap.sh`** there with
   `ZITADEL_SECRETS_DIR=<tmpdir> ZITADEL_INTERNAL_URL=http://localhost:8080 OIDC_ISSUER=http://localhost:8080 WEB_ORIGIN=http://localhost:3000`
   (host tools `jq` / `openssl` / `curl` required — it fails loud if any is missing). The script writes
   `oidc-client.json` + `sa-key.json` into that tmpdir;
6. stashes `sa-key.json` at `~/.lazyit-dev/sa-key.json` (mode `600`, **outside** the repo tree) and
   scrubs the tmpdir;
7. **idempotently** wires the env files (match-and-replace each key in place, never duplicating lines):
   - `apps/web/.env` — `AUTH_ISSUER=http://localhost:8080`, `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET`;
   - `apps/api/.env` — **comments out `AUTH_MODE=shim`** (the web is OIDC-only now, so the API must
     validate the Bearer), `OIDC_ISSUER=http://localhost:8080`,
     `OIDC_JWKS_URI=http://localhost:8080/oauth/v2/keys` (Zitadel serves keys there, **not** the derived
     `/.well-known/jwks.json`), `ZITADEL_MGMT_PROJECT_ID`, `ZITADEL_MGMT_SA_KEY_PATH=~/.lazyit-dev/sa-key.json`.

Both `.env` files are gitignored and the SA key lives outside the tree — **no secret is committed**.
When it finishes, open `http://localhost:3000/setup` to create the first admin **once** (§6b), then
`http://localhost:3000/login`.

> [!tip] Clean re-bootstrap in dev
> `dev:fresh` always re-provisions: it removes the `zitadel_secrets` volume (so a fresh
> `bootstrap-key.json` is exported) and runs the bootstrap script in a **fresh tmpdir** each time, so
> the script's "already provisioned" short-circuit never fires against stale dev creds. To re-run
> against an EXISTING stack instead (no wipe), use `dev:up` — it does not touch Zitadel or the `.env`.

---

## 1 — Prerequisites (manual path)

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
   - `ZITADEL_MASTERKEY` — **exactly 32 bytes** (Zitadel rejects anything shorter *or* longer — a
     wrong length is a real first-boot failure). Generate one that is exactly 32 chars:
     ```sh
     openssl rand -hex 16   # 16 random bytes -> 32 hex chars (exactly 32)
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

> [!note] Manual path only
> Sections 2–5 are the **manual console** alternative to the zero-touch path in §0. Use them only if
> you are provisioning Zitadel by hand (or learning how it works); the bundled flow needs none of it.
> All commands use the consolidated Compose layout (`compose.yaml` + `infra/docker-compose.prod.yaml`
> + `--profile prod`). The old `-f infra/docker-compose.prod.yml` form is superseded
> ([[deploy-self-hosted]]).

Start only Zitadel and its database first (the full stack can come up after bootstrap):

```sh
# From the repo root:
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod \
  --env-file infra/env/.env.prod up -d zitadel_db zitadel caddy
```

Watch the logs — the first start takes **30–90 seconds** because Zitadel initialises its
database schema and creates the first admin user:

```sh
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod \
  --env-file infra/env/.env.prod logs -f zitadel
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

> [!note] Manual path only — the zero-touch sidecar already does ALL of section 4
> The `zitadel-bootstrap` sidecar (§0) creates the project, the OIDC app, the `ADMIN`/`MEMBER`/
> `VIEWER` roles and the runtime service-account, and writes the client id/secret into the shared
> volume — you do **not** copy them by hand. Follow this section only when provisioning manually.

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

With the OIDC credentials now in `.env.prod`, start the remaining services. (The examples below use a
`DC` alias for the long invocation — set it once in your shell.)

```sh
DC="docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod --env-file infra/env/.env.prod"
$DC up -d --build
$DC ps   # verify all services are healthy
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

> [!tip] Primary path is the in-app `/setup` wizard (ADR-0043)
> On a **fresh** zero-touch install you do **not** run anything out-of-band: the first ADMIN is created
> in-app by the **`/setup` wizard** (`POST /config/setup` — idempotent one-time gate + CSRF +
> rate-limit; [[auth-zitadel-sot]] §5). Open the app, the unconfigured state routes you to `/setup`,
> create the first ADMIN, done. The script/SQL below is the **fallback** for the *upgrade* case (an
> instance that already had `MEMBER` users before RBAC, where the wizard self-locks because an
> ADMIN — the seed — already exists) or for BYOI operators who prefer the CLI.

> [!important] Bundled Zitadel — the wizard asks for an INITIAL PASSWORD (issue #335)
> In the **bundled** flow the wizard collects an initial password for the first ADMIN (next to email +
> name), validated against Zitadel's default complexity policy (8–70 chars, upper + lower + digit +
> symbol). The backend sets it on the new Zitadel user (`changeRequired:false`), so you **sign in
> immediately** with your email + that password — there is **no "Set Password" e-mail/code** (the
> bundled stack ships no SMTP, so an emailed initialization code would never arrive and would lock you
> out). The console admin (`ZITADEL_ADMIN_USERNAME` / `ZITADEL_ADMIN_PASSWORD`, §3) remains only for
> emergency IdP administration. In **BYOI** the wizard shows **no** password field — your own IdP owns
> the credential (you create the user there, §6, with a password or initialization email of your own).
> If Zitadel provisioning fails mid-setup, the wizard creates **nothing** (it rolls back and returns a
> retry-able error) rather than leaving a local-only ADMIN you could never sign in as.

> [!note] Default (fresh prod / zero-touch): nothing to do here
> Since #333 the seed creates **no** ADMIN unless `SEED_ADMIN_EMAIL` is explicitly set (it is UNSET in
> prod). So a fresh deploy has an **empty** user table, and the first administrator is owned by the
> in-app **`/setup` wizard** (§6b) — or, equivalently, the **first OIDC login becomes `ADMIN`**
> automatically (the first-user-ADMIN rule fires on the truly-empty DB). The fallback below is only
> for the cases noted next; on a clean install you can skip it.

> [!warning] Why this fallback step exists
> RBAC ([[0040-rbac-roles]]) makes the **first user ever provisioned** an `ADMIN` and everyone else a
> `VIEWER`. But the `rbac_user_role` migration backfilled every **pre-existing** user, and the
> first-user-ADMIN rule **only fires on a truly empty database**. So on an instance that already had
> users (the upgrade case), **or** one where `SEED_ADMIN_EMAIL` seeded an `admin@lazyit.local` whose
> email you can't sign in as, an operator who signs in via OIDC can land as `VIEWER` with **no UI to
> promote themselves**. You then grant the first real `ADMIN` out-of-band, once. After that, admins
> manage every role from the Users section.

> [!tip] If you DID set `SEED_ADMIN_EMAIL` — link the seeded admin by email (no script needed)
> When a seeded admin exists, become the first `ADMIN` without running anything by creating a Zitadel
> user whose **email is the SAME as `SEED_ADMIN_EMAIL`**. The first login **links the two**: the JIT
> path ([[0038-jit-user-provisioning]]) binds your IdP `sub` onto the unclaimed seeded row and you
> **inherit its `ADMIN` role**. (Linking only happens while the seeded row is still unclaimed —
> `externalId IS NULL` — and never steals an email already linked to a different identity → 409.)

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
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod exec api \
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
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod exec db sh -c \
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

For BYOI you also **remove the `zitadel` / `zitadel_db` / `zitadel-bootstrap` services** (below) so the
sidecar does not run, and set `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` (and the `AUTH_*` mirrors)
explicitly. Then restart the affected services:

```sh
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod \
  --env-file infra/env/.env.prod up -d api
```

No code changes needed. Configure the redirect URI in your IdP to:
```
https://yourdomain.com/api/auth/callback/<provider-name>
```

To remove the bundled Zitadel entirely (clean removal path):

```sh
DC="docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod"
# Stop and remove the Zitadel containers (incl. the bootstrap sidecar)
$DC stop zitadel zitadel_db zitadel-bootstrap
$DC rm -f zitadel zitadel_db zitadel-bootstrap

# Remove the Zitadel DB + secrets volumes (destructive — all Zitadel data gone)
docker volume rm lazyit-prod_zitadel_db_data lazyit-prod_zitadel_secrets
```

The app database (`db_data`) is completely unaffected.

---

## Troubleshooting

**Zitadel fails to start — "masterkey must be 32 bytes"**
The `ZITADEL_MASTERKEY` is the wrong length. Zitadel needs **exactly 32 bytes** — shorter *or* longer
both fail (`openssl rand -base64 32` is wrong here: it yields ~44 chars). Generate one that is exactly
32 chars with `openssl rand -hex 16` and update `.env.prod`.

**Zitadel fails to start — DB connection refused**
Check that `zitadel_db` is healthy before `zitadel` starts:
```sh
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod ps zitadel_db
```
The `depends_on: condition: service_healthy` should handle this, but if the healthcheck timing is
tight, restart Zitadel:
`docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod restart zitadel`

**`zitadel-bootstrap` exits non-zero**
The sidecar is `restart: "no"` and fails loud. Read its log:
`docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod logs zitadel-bootstrap`.
Common causes: `OIDC_ISSUER` does not match `ZITADEL_EXTERNALDOMAIN` (token `aud` mismatch / 404
"Instance not found"); `bootstrap-key.json` missing (the `zitadel_secrets` volume is not writable by
Zitadel's uid); or stale creds against a fresh `zitadel_db` (remove the `zitadel_secrets` volume —
see §0b clean re-bootstrap). The sidecar gates on `zitadel` only with `condition: service_started`
(the shell-less zitadel image has no container healthcheck), then **polls `/debug/healthz` itself**
(default up to ~180s) before provisioning — so a `"Zitadel did not become healthy in time"` error in
its log means Zitadel never came up: check the `zitadel` service log first.

**"invalid_client" on OIDC callback**
Double-check `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` match the values in the Zitadel
console. The client secret is shown only once at creation time.

**HTTPS certificate error for auth subdomain**
Verify the DNS A record for `auth.yourdomain.com` is correct and reachable on port 80
(for Let's Encrypt). Check Caddy logs:
```sh
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod logs caddy
```

**Admin password rejected on first login**
Zitadel requires min 8 chars, uppercase, lowercase, digit, and symbol. Reset by stopping
the stack, removing the `zitadel_db_data` volume, updating `ZITADEL_ADMIN_PASSWORD` in
`.env.prod`, and running `start-from-init` again. Only do this on a fresh (unpopulated)
instance.

---

Related: [[0043-zitadel-source-of-truth]] · [[auth-zitadel-sot]] · [[0037-idp-choice-zitadel-byoi]] ·
[[deploy-self-hosted]] · [[0028-secrets-and-config]] · [[0016-auth-strategy-deferred]] ·
[[0026-reverse-proxy-tls]]
