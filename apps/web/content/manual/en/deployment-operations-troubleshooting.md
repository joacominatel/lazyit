---
title: Troubleshooting
order: 6
category: deployment-operations
subcategory: troubleshooting
---

# Troubleshooting

Common symptoms when bringing up or running the containerized stack, and what to check. Run all
commands from the repository root. A handy shorthand for the long prod invocation:

```sh
DC="docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod --env-file infra/env/.env.prod"
$DC ps          # are all services up? did the one-shot jobs exit 0?
$DC logs -f api # follow a service's logs
```

## First, two responses that are *not* failures

- **`/api/...` returns 401 when not signed in.** Correct. Every API route requires authentication;
  an unauthenticated `401` means the guard is working, not that the install is broken.
- **`/api/docs` returns 404.** Also correct. The interactive API docs are deliberately not served on
  the public origin.

## The API won't start

The API only starts after the one-shot **migrate** job finishes successfully. If the API never comes
up, check migrate first:

```sh
$DC logs migrate
```

Common causes: a wrong `DATABASE_URL`, the database not healthy yet, or a genuinely failing migration.
If the API exits immediately complaining that `DATABASE_URL` is not set, make sure
`infra/env/.env.prod` exists and sets it (host `db`, matching the Postgres credentials).

## Postgres won't start

If the database password is **empty**, PostgreSQL refuses to start by design. Set a strong, non-empty
password in the environment file.

## Background import hangs or the API logs "connection refused" on the broker

The background-job broker (Valkey) is unreachable. The usual cause is a missing `REDIS_URL` in the
environment file — common on instances created before background workers shipped, because the guided
bootstrap writes it only on a fresh install — on an existing file it adds nothing but a few generated
keys (see [Upgrades](/help/deployment-operations-upgrades)). Add it and recreate the API:

```sh
grep -q '^REDIS_URL=' infra/env/.env.prod || echo 'REDIS_URL=redis://valkey:6379' >> infra/env/.env.prod
$DC up -d api
```

The broker is reachable as `valkey:6379` on the internal network — never `localhost`. The API no
longer floods on this misconfiguration; it logs the resolved broker URL (password redacted) at boot
and returns a clean error on import instead of hanging.

## Sign-in problems

- **The startup script or the API refuses to start over a leftover of the bundled identity
  provider.** This version no longer ships one, and nothing was changed. See
  [Upgrades](/help/deployment-operations-upgrades#bundled-identity-provider-removed).
- **OIDC: the API won't start.** With `AUTH_MODE=oidc` the API requires `OIDC_ISSUER` and
  `OIDC_JWKS_URI`, and its error names the one that is missing. Set it in the environment file and
  recreate the API.
- **OIDC: your provider rejects the sign-in.** Check that the redirect URI registered in the provider is
  exactly `https://yourdomain.com/api/auth/callback/oidc`, and that `AUTH_ISSUER` and `OIDC_ISSUER`
  match the issuer your provider advertises. See
  [Identity provider](/help/deployment-operations-identity-provider).

## The browser warns about the certificate (local)

On a local prod-like deploy, Caddy uses its internal certificate authority, which browsers don't trust
by default. Accept the warning, or trust Caddy's root certificate once — see
[Reverse proxy & TLS](/help/deployment-operations-reverse-proxy-tls). On a real domain with Let's
Encrypt there is no warning.

## A service is being killed or restarting

Each container has a memory ceiling so one runaway service can't take down the host. If a service is
constrained, watch `docker stats` and raise its limit to suit your box. The background document import
runs in an isolated child process with its own memory cap; if you raise that cap for very large
documents, raise the API's memory limit to match so the child — not the whole API — is the one that
hits the ceiling.

## Search returns nothing after a deploy

The search index is rebuildable and may need a one-time populate after the first deploy (or after
adding search to an existing instance). Run it through the migration image:

```sh
$DC run --rm migrate bun run reindex:all
```

Between deploys the index self-heals on a timer, so you don't normally need to re-index manually.

## Related

- [Self-hosting](/help/deployment-operations-self-hosting)
- [Services](/help/deployment-operations-services)
- [Reverse proxy & TLS](/help/deployment-operations-reverse-proxy-tls)
- [Upgrades](/help/deployment-operations-upgrades)
