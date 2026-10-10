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

> **Back up the database and the environment file first.** Database migrations only move forward —
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

## Support policy

Only the **latest release** is supported — stay current. You do **not** have to install versions one at a
time: jumping across several releases at once (say **1.2 → 1.9**) in a single upgrade is safe, because the
one-shot **migrate** job applies every pending database migration **in order**. The **one exception** is a
**major** version in the range. A major always ships with a **⚠️ Upgrade actions** section in its release
notes describing a manual step you must perform (a new required setting, a topology change). So jump freely
across patch and minor releases, but **stop and read the Upgrade actions for each major you cross**. The
running version is shown on **Settings → General & version**.

### Deprecated features

When a feature, setting, endpoint, or import/export format is being retired, it is **deprecated in a minor
release** first — the release notes say *"deprecated, will be removed in X.0"* — and it keeps working until
then. It is **removed only in the next major**, listed in that major's **⚠️ Upgrade actions** (which you
already read before upgrading). So a minor upgrade never removes something you depend on; watch the release
notes for deprecations and plan the swap before the next major.

#### Infra node-list API removal in v2.0

`GET /infra/nodes` is deprecated and will be removed in **v2.0**. It remains available during the
v1 release line only as the legacy bare-array response for external integrations. Migrate list,
search and exact-id resolver calls to `GET /infra/nodes/page`, which returns
`{ items, total, limit, offset }`. The topology canvas is a different contract and should continue to
use `GET /infra/graph/nodes`; do not substitute the paged list for the map.

#### Bundled identity provider removed

lazyit no longer ships a built-in identity provider: people sign in with local accounts or through your
own OIDC provider (see [Identity provider](/help/deployment-operations-identity-provider)). Installs on
either of those are unaffected. If `./infra/start.sh`, `./infra/update.sh` or the API refuses to start because it found a
leftover of the old bundled provider, nothing was changed — no file written, no volume removed.
Follow the migration runbook in the repository,
`docs/05-runbooks/migrate-off-bundled-zitadel.md`, or stay on the previous release until you can.

## New required settings after a pull

A version that adds a feature may introduce a **new environment value**. A few of them the startup
script can add for you (below); every other one you add by hand, then recreate the affected service.

### Keys the startup script adds for you

If you upgrade with `git pull` followed by `./infra/start.sh`, the script sees your existing install and,
before bringing the stack up, **adds any missing key that is safe to generate** — today the email
password key (`SMTP_SECRET_KEY`), the AI provider key's storage key (`AI_SECRET_KEY`) and the directory
bind password key (`DIRECTORY_SECRET_KEY`). Each only
protects a secret lazyit refuses to save while the key is missing, so a new one can't lock you out of
anything. It works whether you sign in with built-in accounts or an identity provider.

- It **backs up** your environment file first, to `infra/env/.env.prod.bak-<date and time>`. That copy
  holds your secrets: keep it private and delete it once you are satisfied.
- It **only appends**, at the end of the file under a dated comment. Your existing lines are never
  changed, and a key you already have is never replaced.
- It prints the **names** of the keys it added, never their values. Running it again adds nothing.
- `./infra/start.sh --dry-run` shows what it would add without writing anything.

After it adds a key, back up the updated environment file off-host. Keys that protect data you already
have — the workflow secret key, the sign-in secrets, the database passwords — are **never** generated
for you: if one is missing, the script names it and you add it by
hand. The update script (`./infra/update.sh`) never edits the file either; it stops on a missing key and
tells you which one.

### Keys you add by hand

Two examples that have shipped:

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

> The workflow secret key is an **unrotatable** key: it decrypts stored connector credentials. Back it
> up off-host and **never** generate a fresh one on a restore, or those credentials become
> undecryptable. See [Backups & restore](/help/deployment-operations-backups-restore).

Release notes call out any new required value. When in doubt, compare your environment file against the
shipped example (`infra/env/.env.prod.example`) for newly added entries.

## Rolling back

There is no automatic rollback. To go back to a previous version, restore the **pre-upgrade database
backup** and redeploy the previous image. This is exactly why the pre-upgrade backup is mandatory.

## Bundled component versions

The bundled images (database, search, broker, proxy) are pinned to specific versions for reproducible
deploys. They move only on a deliberate bump.

The **search engine** is the exception that needs no preparation. Its data only opens on the exact
engine version that wrote it, so each search-engine upgrade starts on a **new** data volume and lazyit
rebuilds the search index from your database automatically when it starts. There is nothing to run:
expect search results to be **incomplete for a few minutes** after such an upgrade, then complete.
Everything else — sign-in, records, the health check the update script waits on — is unaffected. The
previous search volume is left in place (a rollback to the earlier version uses it) and the startup
script prints the exact command to remove it once you no longer need it, for example:

```
docker volume rm lazyit-prod_meili_data
```

## Related

- [Self-hosting](/help/deployment-operations-self-hosting)
- [Backups & restore](/help/deployment-operations-backups-restore)
- [Troubleshooting](/help/deployment-operations-troubleshooting)
- [Services](/help/deployment-operations-services)
