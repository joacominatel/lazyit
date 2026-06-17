---
title: Self-hosting
order: 1
category: deployment-operations
subcategory: self-hosting
---

# Self-hosting

lazyit is **self-hosted and single-org**: one instance serves one organization, run as a set of
containers on a **single host with Docker Compose**. There is no SaaS and no multi-tenant mode — the
whole stack lives inside your company. This page is the operator's starting point for standing up a
real instance.

> This is the *operator* view. For the first-run, in-app setup (creating the first administrator,
> choosing how people sign in), see [Getting started](/help/getting-started).

## What you need

- A Linux host with **Docker** and **Docker Compose**.
- The repository (or a built artifact) on that host.
- For a public domain with trusted HTTPS: a **DNS record** (A/AAAA) pointing your domain at the host,
  reachable on **ports 80 and 443**. On a private network you can keep Caddy's internal certificate
  authority instead and skip the public DNS requirement.
- A **backup location** off the host — see [Backups & restore](/help/deployment-operations-backups-restore).

A small team (up to ~50 assets) runs comfortably on **2 vCPU / 4 GB RAM / 20 GB disk**. The stack
runs eight long-lived containers plus a one-shot migration job; grow the host with your data.

## The recommended path: the guided bootstrap

The fastest, safest first deploy is the bundled bootstrap script. From the repository root:

```sh
./infra/start.sh
```

It checks prerequisites, asks about six questions (your domain, TLS choice, ports, identity provider,
database), then **generates the environment file with strong random secrets**, brings the whole stack
up, and points you at the in-app setup wizard. It is **idempotent and non-destructive** — re-running
it on an existing install just brings the stack up; it never regenerates the unrotatable master keys
and has no teardown path.

Useful flags:

```sh
./infra/start.sh --yes       # non-interactive localhost defaults (smoke test)
./infra/start.sh --dry-run   # run all checks and prompts, but write nothing and start nothing
./infra/start.sh --help
```

When it finishes it prints your URL and the single next step: open **`https://<your-host>/setup`** to
create the first administrator. The script never creates a user — that is the setup wizard's job.

> Back the generated environment file (`infra/env/.env.prod`) up off-host, encrypted. It holds the
> master keys; lose it and a restored backup is unreadable. See
> [Backups & restore](/help/deployment-operations-backups-restore).

## The manual path

If you prefer full control, do by hand exactly what the script automates. From the repository root:

```sh
cp infra/env/.env.prod.example infra/env/.env.prod
chmod 600 infra/env/.env.prod          # owner-only — this file holds every secret
# edit infra/env/.env.prod: replace every CHANGE_ME value
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml \
  --profile prod --env-file infra/env/.env.prod up -d --build
```

The `chmod 600` is **not optional**: the file holds the database password, the identity-provider
master key, the session secret and more. The default permissions are world-readable.

## What a deploy looks like

- One canonical `compose.yaml` at the repository root defines every service. The full containerized
  stack runs behind the **`prod` profile** — so the prod commands always pass `--profile prod` and
  point at `infra/env/.env.prod`.
- The `--env-file` flag is **required** in production: the compose file resolves `${VAR}` values from
  it at parse time.
- A one-shot **migrate** job applies database migrations and seeds before the API starts, so the
  schema is always in sync after an `up`.
- Only the **Caddy** reverse proxy publishes ports. The databases, API and web app stay on an
  internal Docker network and are never reachable from the host.

After the first deploy, populate the search index once (the API runtime image carries no Bun, so this
runs through the migration image):

```sh
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod \
  --env-file infra/env/.env.prod run --rm migrate bun run reindex:all
```

## Deployment levels

| Level | What runs | Use it for |
| --- | --- | --- |
| **Dev** | backing services in containers + the apps run natively | day-to-day development |
| **Local prod-like** | the full stack in containers, local HTTPS, high ports (8080/8443) | validating a production-shaped deploy on your machine |
| **Self-hosted** | the same stack on a real domain, Let's Encrypt, real secrets, backups | your live instance |

## What's next

- [Services](/help/deployment-operations-services) — what each container does.
- [Identity provider](/help/deployment-operations-identity-provider) — bundled sign-in vs. your own.
- [Reverse proxy & TLS](/help/deployment-operations-reverse-proxy-tls) — Caddy and certificates.
- [Backups & restore](/help/deployment-operations-backups-restore) — what to save, and how to recover.
- [Troubleshooting](/help/deployment-operations-troubleshooting) — when a container won't come up.
- [Upgrades](/help/deployment-operations-upgrades) — updating the instance safely.
