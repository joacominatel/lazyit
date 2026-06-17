---
title: Upgrades
order: 7
category: deployment-operations
subcategory: upgrades
---

# Upgrades

How to move an instance to a newer version of lazyit. Upgrades are routine — pull the new code, rebuild
the images, bring the stack up — but **always back up first**, because database migrations are
forward-only.

## Before you upgrade

> **Back up both databases and the environment file first.** Database migrations only move forward —
> there is no automatic rollback. Your safety net is the pre-upgrade backup. See
> [Backups & restore](/help/deployment-operations-backups-restore).

## The upgrade

From the repository root:

```sh
git pull          # or ship a new built artifact / image
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml \
  --profile prod --env-file infra/env/.env.prod up -d --build
```

The rebuild brings up the new images, and the one-shot **migrate** job re-runs automatically before the
API starts — applying any new database migrations (a no-op if there's nothing pending). You don't run
migrations by hand.

## New required settings after a pull

A version that adds a feature may introduce a **new required environment value**. The guided bootstrap
only writes new values on a fresh render — it never edits an existing environment file — so after
pulling a version that needs one, add it by hand and recreate the affected service. Two examples that
have shipped:

- The **background-job broker URL** (`REDIS_URL`), required since background workers shipped. If it's
  missing, background document import fails.

  ```sh
  grep -q '^REDIS_URL=' infra/env/.env.prod || echo 'REDIS_URL=redis://valkey:6379' >> infra/env/.env.prod
  docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod \
    --env-file infra/env/.env.prod up -d api
  ```

- The **workflow secret key** (`WORKFLOW_SECRET_KEY`), required before enabling the Applications
  Workflow Engine. The API fails loud at boot if the engine is enabled and the key is missing or the
  wrong length.

  ```sh
  grep -q '^WORKFLOW_SECRET_KEY=' infra/env/.env.prod \
    || echo "WORKFLOW_SECRET_KEY=$(openssl rand -hex 32)" >> infra/env/.env.prod
  docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod \
    --env-file infra/env/.env.prod up -d api
  ```

> The workflow secret key is an **unrotatable** key, like the identity-provider master key: it decrypts
> stored connector credentials. Back it up off-host and **never** generate a fresh one on a restore, or
> those credentials become undecryptable. See [Backups & restore](/help/deployment-operations-backups-restore).

Release notes call out any new required value. When in doubt, compare your environment file against the
shipped example (`infra/env/.env.prod.example`) for newly added entries.

## Rolling back

There is no automatic rollback. To go back to a previous version, restore the **pre-upgrade database
backup** and redeploy the previous image. This is exactly why the pre-upgrade backup is mandatory.

## Bundled component versions

The bundled images (database, identity provider, search, broker, proxy) are pinned to specific
versions for reproducible deploys. They move only on a deliberate bump. Before bumping the identity
provider in particular, back up its database **and** keep the matching master key, since its data is
tied to that key.

## Related

- [Self-hosting](/help/deployment-operations-self-hosting)
- [Backups & restore](/help/deployment-operations-backups-restore)
- [Troubleshooting](/help/deployment-operations-troubleshooting)
- [Services](/help/deployment-operations-services)
