---
title: Services
order: 2
category: deployment-operations
subcategory: services
---

# Services

A lazyit instance is a small set of containers on one host. This page explains what each one does, so
you know which logs to read and what is safe to restart. The reverse proxy is the **only** service
that publishes ports to the host; everything else lives on an internal Docker network.

## The containers

| Service | Role | Notes |
| --- | --- | --- |
| **caddy** | Reverse proxy + automatic HTTPS | The only public-facing service. Routes `/` to the web app and `/api/*` to the API. |
| **web** | The Next.js web app | Serves the user interface; runs sign-in server-side. |
| **api** | The NestJS API | All business logic. Also runs the background workers. |
| **db** | PostgreSQL — the application database | The system of record. Holds all your data. |
| **migrate** | One-shot migration + seed job | Runs once per deploy, then exits. Applies schema migrations before the API starts. |
| **valkey** | Background-job broker | Backs the async workers (e.g. document import, the workflow engine). |
| **meilisearch** | Search engine | Powers cross-entity search. Rebuildable from the database. |

No identity provider runs in the stack. With local accounts lazyit handles sign-in itself; with your
own OIDC provider, sign-in goes to a service you run elsewhere (see
[Identity provider](/help/deployment-operations-identity-provider)). An optional **backup** sidecar
can also run alongside — see [Backups & restore](/help/deployment-operations-backups-restore).

## How the pieces fit together

- The browser only ever talks to **Caddy** over HTTPS. Caddy forwards page requests to **web** and
  API requests to **api** on the internal network. Because the web app calls the API at the relative
  path `/api`, one image works on any domain.
- **api** reads and writes the **db** (PostgreSQL), pushes background jobs to **valkey**, and keeps
  **meilisearch** in sync as data changes.
- **migrate** runs first on every deploy: it applies database migrations and a small idempotent seed,
  then exits. The API waits for it to finish successfully before starting.
- Sign-in is handled by **web** and **api** — against lazyit's own accounts, or by validating the tokens
  your OIDC provider issues.

## One database

The stack runs **one** PostgreSQL database, the application database (**db**). It holds your data and,
with local accounts, the sign-in credentials too. See [Backups &
restore](/help/deployment-operations-backups-restore).

## What is and isn't a backup target

- **db** holds real state — **back it up.**
- **meilisearch** is rebuildable: its index is reconstructed from the database with a re-index
  command, so its data does not need backing up.
- **valkey** holds only in-flight background-job state (PostgreSQL is the system of record), so it is
  not a backup target either. Its data survives restarts so queued jobs aren't lost.
- **caddy** re-obtains its certificates automatically, so its state needs no backup.

## Resource limits and logs

Every long-running container has a modest memory and CPU ceiling and a log-rotation policy, so one
runaway service can't exhaust the host and logs can't fill the disk over months. Tune the limits to
your box if a service is constrained — watch `docker stats`. The full sizing guidance lives in the
self-hosted deployment runbook.

## Related

- [Self-hosting](/help/deployment-operations-self-hosting)
- [Identity provider](/help/deployment-operations-identity-provider)
- [Reverse proxy & TLS](/help/deployment-operations-reverse-proxy-tls)
- [Troubleshooting](/help/deployment-operations-troubleshooting)
