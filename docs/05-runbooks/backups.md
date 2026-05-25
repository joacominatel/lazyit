---
title: Database Backup & Restore
tags: [runbook, database, backups]
status: accepted
created: 2026-05-25
updated: 2026-05-25
---

# Runbook — Postgres backup & restore

How to back up and restore the lazyit database. lazyit holds sensitive inventory/access data on a
single host ([[0015-deployment-model]]); a working, tested restore is mandatory before real use.

> [!info] Manual now, automation later
> This runbook is the **manual** procedure (decided 2026-05-25). Postgres is not published to the
> host ([[0028-secrets-and-config]]), so backups run *inside* the compose network via
> `docker compose exec`. Automating it (a cron/sidecar that dumps on a schedule + offsite copy) is
> deferred — wire it up when there's a real deployment to protect.

All commands run from the repo root, against the prod-like / self-hosted stack
(`infra/docker-compose.prod.yml`). `$PG` below is just shorthand:

```sh
PG="docker compose -f infra/docker-compose.prod.yml exec -T db"
```

## Back up

```sh
# Logical dump (custom format = compressed, supports selective restore). POSTGRES_USER/DB come
# from the container env (.env.prod).
$PG sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "lazyit-$(date +%Y%m%d-%H%M%S).dump"
```

This writes a timestamped `lazyit-*.dump` to the current directory. **Copy it off the host** to a
secure, access-controlled location (the dump contains all data). Also back up `infra/env/.env.prod`
separately — it holds the DB password and is needed to read a restored database.

> [!tip] Plain SQL alternative
> For a human-readable dump: `... pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"` (no `-Fc`) and
> redirect to `lazyit-*.sql`. Restore a plain dump with `psql` instead of `pg_restore`.

## Restore

> [!warning] Destructive
> Restoring overwrites current data. Take a fresh backup first, and prefer restoring into a clean
> database. Never test a restore against a database you can't afford to lose.

```sh
# Into the EXISTING database (drops & recreates objects from the dump):
cat lazyit-20260525-120000.dump | $PG sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists'

# Cleanest: restore into a freshly recreated database.
docker compose -f infra/docker-compose.prod.yml down -v     # removes db_data (ALL data)
docker compose -f infra/docker-compose.prod.yml up -d db    # fresh, empty db (auto-created)
# wait until healthy, then load the dump:
cat lazyit-20260525-120000.dump | $PG sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner'
# then bring up the rest (migrate will be a no-op if the dump already matches the schema):
docker compose -f infra/docker-compose.prod.yml up -d
```

## Verify a restore

```sh
docker compose -f infra/docker-compose.prod.yml exec -T db \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select count(*) from users;"
# Or hit the API: curl -sk https://localhost:8443/api/users
```

## What's NOT covered here (yet)

- **Scheduled/offsite automation** — deferred (see the note above). A simple approach when needed:
  a small cron on the host running the backup command + uploading the dump to object storage,
  or a backup sidecar container. Decide and add it as its own section/runbook then.
- **Point-in-time recovery (PITR / WAL archiving)** — out of scope for a single-host, small-team
  deployment; revisit only if the recovery objective demands it.

Related: [[deploy-self-hosted]] · [[docker-prod-like-first-boot]] · [[prisma-migrations]] ·
[[0028-secrets-and-config]] · [[0015-deployment-model]]
