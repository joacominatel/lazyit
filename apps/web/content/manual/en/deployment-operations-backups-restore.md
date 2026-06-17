---
title: Backups & restore
order: 3
category: deployment-operations
subcategory: backups-restore
---

# Backups & restore

How to back up everything a lazyit instance needs to survive disk loss, and how to restore it in the
right order. A working, **tested** restore is mandatory before you trust an instance with real data.

> The single most common disaster-recovery mistake is backing up only the application database. The
> stack runs **two** databases, and the keys that unlock them live in the environment file. Miss any
> one of those three things and the worst case is: "I restored the backup, and nobody can log in."

## What to back up

| Item | Where it lives | Back up? |
| --- | --- | --- |
| **Environment file** (`infra/env/.env.prod`) | a file on the host | **Yes — off-host, encrypted.** Irreplaceable: it holds the database password and the master keys. |
| **Application database** | the `db` service | **Yes.** Your data. |
| **Identity-provider database** | the `zitadel_db` service | **Yes** — and you must keep the *matching* master key with it. |
| Search index | the `meilisearch` service | No — rebuildable by re-indexing from the databases. |
| TLS certificates | the `caddy` service | No — re-issued automatically. |

The environment file is your responsibility to copy off-host. The two databases can be dumped
automatically by the optional backup sidecar (below).

## The keys you cannot lose

Two master keys live in the environment file and are **unrotatable and irreplaceable**. They are not
inside any database dump — they are the keys that make the dumps readable:

- The **identity-provider master key** decrypts the identity provider's store. Lose it and a perfect
  database dump still can't log anyone in.
- The **workflow secret key** decrypts the credentials stored by the Applications Workflow Engine.
  Restore the database without the matching key and those connector credentials become undecryptable.

Never generate a fresh value for either key on a restore. Keep a sealed copy off-host, and always back
them up alongside the *matching* database dump.

## The Secret Manager is a deliberate exception

The recovery rule "a database dump plus the matching environment key makes the data readable again"
holds for everything **except** the Secret Manager, which is **end-to-end (zero-knowledge) encrypted**.
Its decryption keys are **held by users**, never by the server and never in the environment file.

What this means for recovery:

- A perfect database-and-environment restore does **not** make vault values readable on its own. The
  restored rows hold only ciphertext. Values come back when a surviving member signs in, or when a
  surviving member redeems **their own** recovery key.
- The **recovery key is the user's personal, shown-once artifact** — it is the user's responsibility
  to store it off-host. The operator cannot back it up for them. Make "store your recovery key safely"
  part of onboarding.
- A vault whose only member loses **both** their sign-in and their recovery key is **permanent loss by
  design** — no database restore and no administrator can recover the plaintext. Keep sensitive vaults
  multi-member so a peer can restore access. See [Secret Manager](/help/secret-manager).

## Automated backups (optional sidecar)

An opt-in **backup** service dumps **both** databases on a schedule to a host folder, with retention,
and an optional off-site copy hook. It is off by default. Bring it up alongside the running stack:

```sh
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --env-file infra/env/.env.prod \
  --profile prod --profile backup up -d backup
```

Tune it in the environment file (defaults shown):

```sh
BACKUP_CRON="30 2 * * *"     # when to run (crontab syntax) — daily at 02:30 by default
BACKUP_RETENTION_DAYS=14     # prune dumps older than this many days
BACKUP_OFFSITE_CMD=          # optional off-site copy hook — off unless you set it
```

The sidecar writes timestamped dumps for both databases into `./backups`. It does **not** back up the
environment file — copy that off-host yourself.

## Manual backup

Both databases stay on the internal network, so dumps run inside the compose network. The custom
format (`-Fc`) is compressed and supports selective restore:

```sh
DC="docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod"
# Application database:
$DC exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "app-$(date +%Y%m%d-%H%M%S).dump"
# Identity-provider database (its own credentials):
$DC exec -T zitadel_db sh -c 'pg_dump -U "$ZITADEL_DB_USER" -d "$ZITADEL_DB_NAME" -Fc' > "zitadel-$(date +%Y%m%d-%H%M%S).dump"
```

Copy both dumps **and** `infra/env/.env.prod` off the host, to a secure, access-controlled location.

## Restore

> Restoring overwrites current data. Take a fresh backup first, and never test a restore against a
> database you can't afford to lose.

For a full recovery onto a rebuilt host, restore in this order:

1. **Put the environment file back first.** It must contain the **same master keys** as when the
   databases were dumped. `chmod 600 infra/env/.env.prod`.
2. **Restore the identity-provider database** from its dump.
3. **Restore the application database** from its dump.
4. **Bring the stack up.**
5. **Re-index search** — the index is rebuildable:

```sh
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod \
  --env-file infra/env/.env.prod run --rm migrate bun run reindex:all
```

> **Never reset a single database with `down -v`.** That command removes **all** named volumes —
> including the entire identity provider (every account and the OIDC client). To reset just one
> database, remove only its volume (for the application database that is
> `docker volume rm lazyit-prod_db_data`), bring that service up fresh, then load the dump.

Restoring each database has the same shape — dump in, with the right credentials. Verify the restore
end-to-end by signing in through the web app: a successful login is the real proof that both databases
and the master key line up.

## Related

- [Self-hosting](/help/deployment-operations-self-hosting)
- [Services](/help/deployment-operations-services)
- [Upgrades](/help/deployment-operations-upgrades)
- [Secret Manager](/help/secret-manager)
