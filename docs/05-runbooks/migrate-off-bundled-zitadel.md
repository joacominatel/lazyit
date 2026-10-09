---
title: Migrate Off the Bundled Zitadel
tags: [runbook, auth, oidc, zitadel, upgrade]
status: accepted
created: 2026-10-09
updated: 2026-10-09
---

# Runbook — migrate off the bundled Zitadel

lazyit no longer ships an identity provider ([[0102-remove-bundled-zitadel]]). Earlier releases could
run a bundled Zitadel next to the app (`AUTH_MODE=oidc` with the `oidc` compose profile). No live
instance is known to run it; this runbook is for a stray one. There is no migration tooling — only
guards that stop before changing anything, and the options below.

## Recognise the refusal

Three guards refuse a bundled install, and none of them changes anything:

- **`./infra/start.sh`** on the existing install: `[ABORT] infra/env/.env.prod belongs to a
  bundled-Zitadel install (…)`, naming this runbook. No file written, no container started.
- **`./infra/update.sh vX.Y.Z`**, once your installed copy is from the release that removed the
  bundled Zitadel or later: the same message, before the lock, the backup or the checkout.
- **The API at boot** (`… logs api`): `CRITICAL: invalid boot configuration — refusing to start.`
  with `ZITADEL_MASTERKEY`, `OIDC_ISSUER` or `OIDC_JWKS_URI` *"is a leftover of the bundled Zitadel"*.

The scripts look for an active `ZITADEL_MASTERKEY`; an `OIDC_ISSUER`, `OIDC_JWKS_URI`, `AUTH_ISSUER` or
`AUTH_INTERNAL_ISSUER` pointing at `zitadel:8080`; or a `lazyit-prod_zitadel_db_data` volume with no
`OIDC_CLIENT_ID`. An `AUTH_MODE=local` install is never refused: it never used the IdP.

> [!warning] Do not run `update.sh` across this release on a bundled install
> `update.sh` always runs the copy from the version you are **leaving**, and older copies have no
> guard. That copy backs up, checks out the new release and builds it; the new API then refuses to
> start, and `update.sh` rolls back — or, if the release carried a database migration, stops and
> prints a restore. Pick an option below first.

## Before anything — back up

On the release you run today (its checkout still has the `oidc` overlay), from the repo root:

```sh
DC="docker compose -f compose.yaml -f infra/docker-compose.prod.yaml -f infra/docker-compose.oidc.yaml \
  --profile prod --profile oidc --env-file infra/env/.env.prod"
$DC exec -T db         sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > app-pre-zitadel-removal.dump
$DC exec -T zitadel_db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > zitadel-pre-zitadel-removal.dump
```

Copy both dumps **and `infra/env/.env.prod`** off the host. The `ZITADEL_MASTERKEY` in that file is
the only key to Zitadel's data: without it the Zitadel dump is unreadable, and it cannot be rotated.

## Option A — stay on the previous release

Keep the checkout where it is and do not update. Nothing changes, and nothing improves: support is
latest-only ([[releasing]]), so this buys time, not a destination.

## Option B — keep your Zitadel, run it outside lazyit

The same Zitadel keeps the same issuer and the same subjects (`sub`), so every person signs in exactly
as before and **no lazyit data changes**. Zitadel becomes an ordinary OIDC provider that you run
([[auth-bootstrap]]).

1. **Copy the client credentials** the bootstrap sidecar stored, read-only:

   ```sh
   docker run --rm -v lazyit-prod_zitadel_secrets:/s:ro alpine cat /s/oidc-client.json
   ```

   Keep `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` from the output.

2. **Stop and remove lazyit's Zitadel containers** — never run two Postgres servers on one volume.
   The named volumes stay:

   ```sh
   $DC rm -sf zitadel zitadel-bootstrap zitadel-secrets-init zitadel_db
   ```

3. **Run Zitadel as its own compose project**, reusing the two volumes as external. A starting point,
   in a directory outside the lazyit checkout, with the values copied from lazyit's `.env.prod` into a
   `.env` there (mode 600):

   ```yaml
   name: zitadel
   services:
     zitadel_db:
       image: postgres:16-alpine
       restart: unless-stopped
       environment:
         POSTGRES_USER: ${ZITADEL_DB_USER}
         POSTGRES_PASSWORD: ${ZITADEL_DB_PASSWORD}
         POSTGRES_DB: ${ZITADEL_DB_NAME}
       volumes: [zitadel_db_data:/var/lib/postgresql]
       healthcheck:
         test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
         interval: 10s
     zitadel:
       image: ghcr.io/zitadel/zitadel:v2.68.0
       command: start-from-init --masterkey "${ZITADEL_MASTERKEY}" --tlsMode external
       restart: unless-stopped
       environment:
         ZITADEL_DATABASE_POSTGRES_HOST: zitadel_db
         ZITADEL_DATABASE_POSTGRES_PORT: "5432"
         ZITADEL_DATABASE_POSTGRES_DATABASE: ${ZITADEL_DB_NAME}
         ZITADEL_DATABASE_POSTGRES_USER_USERNAME: ${ZITADEL_DB_USER}
         ZITADEL_DATABASE_POSTGRES_USER_PASSWORD: ${ZITADEL_DB_PASSWORD}
         ZITADEL_DATABASE_POSTGRES_USER_SSL_MODE: disable
         ZITADEL_DATABASE_POSTGRES_ADMIN_USERNAME: ${ZITADEL_DB_USER}
         ZITADEL_DATABASE_POSTGRES_ADMIN_PASSWORD: ${ZITADEL_DB_PASSWORD}
         ZITADEL_DATABASE_POSTGRES_ADMIN_SSL_MODE: disable
         ZITADEL_EXTERNALSECURE: "true"
         ZITADEL_EXTERNALPORT: ${ZITADEL_EXTERNALPORT}
         ZITADEL_EXTERNALDOMAIN: ${ZITADEL_EXTERNALDOMAIN}
       depends_on:
         zitadel_db: { condition: service_healthy }
       ports: ["127.0.0.1:8081:8080"]
   volumes:
     zitadel_db_data: { external: true, name: lazyit-prod_zitadel_db_data }
   ```

   Keep the **same image version and the same external domain, port and scheme** as before — they
   define the issuer. `ZITADEL_EXTERNALPORT` is the `LAZYIT_HTTPS_PORT` your install used (443 on a
   public host).

4. **Serve `auth.<your-domain>` yourself.** lazyit's Caddy no longer has that site, and it has no hook
   for extra ones. Put Zitadel behind a reverse proxy you control, at exactly the old issuer URL: on
   another host (move the DNS record), or on this one behind a front proxy that owns the TLS port for
   both names and forwards `<your-domain>` to lazyit's Caddy. With Caddy that site is
   `auth.example.com { reverse_proxy 127.0.0.1:8081 }`. Check it answers:

   ```sh
   curl -s https://auth.example.com/.well-known/openid-configuration | grep -o '"issuer":"[^"]*"'
   ```

5. **Rewire lazyit's `.env.prod`:**

   ```sh
   AUTH_MODE=oidc
   OIDC_ISSUER=https://auth.example.com                       # unchanged
   OIDC_JWKS_URI=https://auth.example.com/oauth/v2/keys       # was http://zitadel:8080/…
   OIDC_CLIENT_ID=<OIDC_CLIENT_ID from step 1>
   AUTH_ISSUER=https://auth.example.com                       # unchanged
   AUTH_CLIENT_ID=<OIDC_CLIENT_ID from step 1>
   AUTH_CLIENT_SECRET=<OIDC_CLIENT_SECRET from step 1>
   ```

   Comment out every `ZITADEL_*` line — they now belong to Zitadel's own `.env` — and
   `AUTH_INTERNAL_ISSUER` (it pointed at `zitadel:8080`; use [[auth-bootstrap]] §3c if Zitadel needs an
   internal route). `LAZYIT_DOMAIN`, `OIDC_CLIENT_FILE` and `ZITADEL_MGMT_*` are no longer read.

6. **Update lazyit with `start.sh`, not `update.sh`** — the `update.sh` you have still dumps
   `zitadel_db`, which no longer runs in lazyit's project:

   ```sh
   git fetch --tags && git checkout vX.Y.Z && ./infra/start.sh
   ```

   `start.sh` now finds no bundled leftovers, keeps every secret and brings the stack up. Later updates
   use `./infra/update.sh` as usual.

7. **Sign in** with an existing account. The Zitadel console stays at
   `https://auth.example.com/ui/console`. lazyit no longer uses Zitadel's management service account;
   you may deactivate it there.

**Keep `ZITADEL_MASTERKEY` backed up** with Zitadel's `.env` and dumps — lazyit's backups no longer
cover Zitadel ([[backups]]).

## Option C — move to another IdP, or to local accounts

Possible, but **there is no tooling**, and both lose the link between people and their sign-ins:

- **Another IdP.** Register a client and set the env as in [[auth-bootstrap]]. Every existing person is
  bound to Zitadel's `sub`; a sign-in from the new IdP with the same email is **refused** (409,
  *"already linked to a different identity"*) rather than re-linked. The binding is `users.externalId`;
  lazyit does not support or document rewriting it.
- **Local accounts.** Not supported: `AUTH_MODE` is fixed per instance, and the API refuses to start
  when it differs from the mode recorded at setup ([[0086-local-authentication-mode]] §1). A local-auth
  instance starts from an empty database.

## Cleanup — once Zitadel's data is no longer needed

lazyit never removes these volumes; compose does not either, not even on `down -v`, because nothing
declares them any more. When you are done with them — **never under option B, which still uses them**
— take a backup, then run it yourself:

```sh
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod \
  --env-file infra/env/.env.prod up -d --remove-orphans          # removes leftover zitadel* containers
docker volume rm lazyit-prod_zitadel_db_data lazyit-prod_zitadel_secrets
```

Related: [[0102-remove-bundled-zitadel]] · [[auth-bootstrap]] · [[backups]] · [[releasing]] ·
[[deploy-self-hosted]] · [[0086-local-authentication-mode]]
