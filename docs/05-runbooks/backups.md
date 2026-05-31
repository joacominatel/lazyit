---
title: Backups & Disaster Recovery
tags: [runbook, database, backups, disaster-recovery]
status: accepted
created: 2026-05-25
updated: 2026-05-30
---

# Runbook — backups & disaster recovery

How to back up **everything lazyit needs to survive disk loss**, and how to restore it in the
right order. lazyit holds sensitive inventory/access data on a single host
([[0015-deployment-model]]); a working, tested restore is mandatory before real use.

> [!danger] The #1 DR mistake: backing up only the app DB
> The prod stack now runs **two** Postgres databases — the app DB **and** Zitadel's own DB
> ([[0037-idp-choice-zitadel-byoi]]) — plus secrets in `.env.prod`. **Restoring only the app DB leaves
> every user locked out**: Zitadel's accounts, the OIDC client, and its `ZITADEL_MASTERKEY`-encrypted
> store are gone. And a Zitadel DB restored **without the matching `ZITADEL_MASTERKEY`** is
> unreadable. "I restored the backup and nobody can log in" is the worst DR outcome — this runbook
> exists to prevent it.

## What to back up (DR inventory)

| # | Item | Where | Back up? | How to recover if lost |
| - | --- | --- | --- | --- |
| 1 | **`infra/env/.env.prod`** | host file (gitignored) | **YES — off-host, encrypted** | Irreplaceable. Holds the DB password, `ZITADEL_MASTERKEY` (the DR linchpin), `AUTH_SECRET`, OIDC secrets. |
| 2 | **App database** | `db` (Postgres 18, `db_data` volume) | **YES — `pg_dump`** | Restore from dump. |
| 3 | **Zitadel database** | `zitadel_db` (Postgres 16, `zitadel_db_data` volume) | **YES — `pg_dump`** | Restore from dump **+ the same `ZITADEL_MASTERKEY`**. |
| 4 | Meilisearch index | `meili_data` volume | No (rebuildable) | Re-run `reindex:all` — it rebuilds the index from the DBs ([[0035-search-architecture]]). |
| 5 | Caddy TLS state | `caddy_data` / `caddy_config` volumes | No (re-issuable) | Caddy re-obtains certs from Let's Encrypt (or re-mints its internal CA) automatically. |

> [!warning] `ZITADEL_MASTERKEY` is unrotatable and irreplaceable
> It decrypts Zitadel's store. Losing it = losing all logins, even with a perfect DB dump. Keep a
> sealed copy off-host (see [[auth-bootstrap]]). It lives in item #1 (`.env.prod`) — so backing up
> `.env.prod` covers it, but never let that file be your *only* copy of the masterkey.

> [!info] Automation: the opt-in backup sidecar (see below)
> Items #2 and #3 can be automated by the `backup` profile service in
> `infra/docker-compose.prod.yml` (cron + `pg_dump` for both DBs to a host-mounted `./backups`,
> with retention). Item #1 is **your responsibility** — `.env.prod` must be copied off-host
> manually and access-controlled.

All commands run from the repo root, against the prod-like / self-hosted stack
(`infra/docker-compose.prod.yml`). Postgres is not published to the host
([[0028-secrets-and-config]]), so backups run *inside* the compose network via
`docker compose exec`. Shorthands:

```sh
PG="docker compose -f infra/docker-compose.prod.yml exec -T db"          # app DB
ZPG="docker compose -f infra/docker-compose.prod.yml exec -T zitadel_db" # Zitadel DB
```

## Manual backup — both databases

```sh
# 1) App DB. POSTGRES_USER/DB come from the container env (.env.prod). Custom format (-Fc) is
#    compressed and supports selective restore.
$PG sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "app-$(date +%Y%m%d-%H%M%S).dump"

# 2) Zitadel DB. It uses its OWN credentials (ZITADEL_DB_USER/ZITADEL_DB_NAME from .env.prod).
$ZPG sh -c 'pg_dump -U "$ZITADEL_DB_USER" -d "$ZITADEL_DB_NAME" -Fc' > "zitadel-$(date +%Y%m%d-%H%M%S).dump"
```

This writes timestamped `app-*.dump` and `zitadel-*.dump` to the current directory. **Copy them
off the host** to a secure, access-controlled location, **together with `infra/env/.env.prod`**
(the dumps are unreadable for DR purposes without the masterkey it holds).

> [!tip] Plain SQL alternative
> Drop `-Fc` and redirect to `*.sql` for a human-readable dump; restore it with `psql` instead of
> `pg_restore`.

> [!note] gitignore the dumps
> `*.dump`, `*.sql`, and the sidecar's `./backups/` are **not** auto-ignored by the repo's
> `.gitignore`. If you keep dumps inside the working tree, add them to `.gitignore` so a stray
> `git add` never commits a file full of secrets.

## Automated backup — the opt-in sidecar

A `backup` profile service (off by default) runs cron + `pg_dump` for **both** DBs on a schedule,
writes timestamped dumps to the host-mounted `./backups` directory, and prunes old ones. Enable it:

```sh
# Bring up just the sidecar (the rest of the stack should already be up):
docker compose -f infra/docker-compose.prod.yml --env-file infra/env/.env.prod \
  --profile backup up -d backup
```

Tune via `.env.prod` (all optional — sane defaults shown):

```sh
BACKUP_CRON="30 2 * * *"     # when to run (crontab syntax). Default: daily 02:30.
BACKUP_RETENTION_DAYS=14     # prune dumps older than this many days. Default: 14.
# OPTIONAL offsite copy — OFF unless set. Runs once per dump with the dump path as "$1".
# Example (rclone to a remote named "offsite"): BACKUP_OFFSITE_CMD='rclone copy "$1" offsite:lazyit/'
BACKUP_OFFSITE_CMD=
```

The sidecar writes `app-<ts>.dump` and `zitadel-<ts>.dump` into `./backups` (repo root). **It does
NOT back up `.env.prod`** — copy that off-host yourself. Offsite is OFF by default (respects the
"no mandatory cloud" stance, [[0028-secrets-and-config]]); wire `BACKUP_OFFSITE_CMD` only if you
want it. Check it ran:

```sh
docker compose -f infra/docker-compose.prod.yml logs backup   # "[lazyit-backup] run ... complete"
ls -lh backups/
```

## Restore

> [!warning] Destructive
> Restoring overwrites current data. Take a fresh backup first, and prefer restoring into a clean
> database. Never test a restore against a database you can't afford to lose.

### Restore order (full DR — host rebuilt from scratch)

1. **`.env.prod` first** — put your backed-up `infra/env/.env.prod` back (it must contain the
   **same `ZITADEL_MASTERKEY`** as when the Zitadel DB was dumped). `chmod 600 infra/env/.env.prod`.
2. **Zitadel DB** — restore `zitadel-*.dump` (subsection below).
3. **App DB** — restore `app-*.dump` (subsection below).
4. **Bring the stack up** — `docker compose -f infra/docker-compose.prod.yml up -d`.
5. **Reindex Meilisearch** — `docker compose -f infra/docker-compose.prod.yml run --rm migrate bun run reindex:all`
   (the index is rebuildable; see [[deploy-self-hosted]] §2a).

### Restore the app DB

```sh
# Into the EXISTING database (drops & recreates objects from the dump):
cat app-20260530-120000.dump | $PG sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists'

# Cleanest: reset ONLY the app DB volume, then restore into a fresh db.
docker compose -f infra/docker-compose.prod.yml down            # stop the stack (keeps volumes)
docker volume rm lazyit-prod_db_data                            # remove ONLY the app DB volume
docker compose -f infra/docker-compose.prod.yml up -d db        # fresh, empty app db (auto-created)
# wait until healthy, then load the dump:
cat app-20260530-120000.dump | $PG sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner'
# then bring up the rest (migrate is a no-op if the dump already matches the schema):
docker compose -f infra/docker-compose.prod.yml up -d
```

> [!danger] NEVER use `down -v` to reset just the app DB
> `down -v` removes **ALL five** named volumes in the project — including `zitadel_db_data`
> (the entire IdP: users, OIDC client, masterkey-encrypted store), `meili_data`, `caddy_data`,
> and `caddy_config`. Resetting the app DB with `down -v` silently **wipes your Zitadel IdP** and
> turns a routine restore into a compound outage. Use the targeted
> `docker volume rm lazyit-prod_db_data` shown above (the `lazyit-prod_` prefix is the compose
> project `name:`).

### Restore Zitadel

Same shape as the app DB, but against `zitadel_db` with Zitadel's own credentials — and the
**same `ZITADEL_MASTERKEY`** must already be in `.env.prod` (step 1 above) or the restored store
is undecryptable.

```sh
# Into the EXISTING Zitadel database:
cat zitadel-20260530-120000.dump | $ZPG sh -c 'pg_restore -U "$ZITADEL_DB_USER" -d "$ZITADEL_DB_NAME" --clean --if-exists'

# Cleanest: reset ONLY the Zitadel DB volume, then restore.
docker compose -f infra/docker-compose.prod.yml down
docker volume rm lazyit-prod_zitadel_db_data                       # remove ONLY the Zitadel DB volume
docker compose -f infra/docker-compose.prod.yml up -d zitadel_db   # fresh, empty zitadel db
# wait until healthy, then load the dump:
cat zitadel-20260530-120000.dump | $ZPG sh -c 'pg_restore -U "$ZITADEL_DB_USER" -d "$ZITADEL_DB_NAME" --no-owner'
docker compose -f infra/docker-compose.prod.yml up -d              # bring up the rest
```

If you are restoring onto a **brand-new** Zitadel (no prior dump), do not restore — instead
re-run the bootstrap in [[auth-bootstrap]]; you will get a new instance and must re-register the
OIDC client.

## Verify a restore

```sh
# App DB: row count.
docker compose -f infra/docker-compose.prod.yml exec -T db \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select count(*) from users;"

# Zitadel DB: the schema came back.
docker compose -f infra/docker-compose.prod.yml exec -T zitadel_db \
  psql -U "$ZITADEL_DB_USER" -d "$ZITADEL_DB_NAME" -c "\dn"

# End to end: log in via the web UI (this is the real proof both DBs + the masterkey line up).
```

## What's NOT covered here

- **Point-in-time recovery (PITR / WAL archiving)** — out of scope for a single-host, small-team
  deployment; revisit only if the recovery objective demands it.
- **Upgrade/rollback of the bundled components** — see [[deploy-self-hosted]] (forward-only Prisma
  migrations mean rollback = restore the pre-upgrade dump + redeploy the previous image).

Related: [[deploy-self-hosted]] · [[docker-prod-like-first-boot]] · [[prisma-migrations]] ·
[[auth-bootstrap]] · [[0028-secrets-and-config]] · [[0015-deployment-model]] · [[0037-idp-choice-zitadel-byoi]]
