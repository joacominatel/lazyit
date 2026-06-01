---
title: "ADR-0037: IdP choice — Zitadel, BYOI strategy, own Postgres"
tags: [adr, auth, infra, oidc]
status: accepted
created: 2026-05-26
updated: 2026-05-26
deciders: [Joaquín Minatel]
---

# ADR-0037: IdP choice — Zitadel, BYOI strategy, own Postgres

## Status

accepted — 2026-05-26. Resolves the pending IdP provider choice left open in [[0016-auth-strategy-deferred]].

## Context

[[0016-auth-strategy-deferred]] decided that lazyit will use **OIDC integration with a self-hosted
IdP** rather than implementing its own auth. It deferred only the provider choice: "Authentik /
Keycloak / Zitadel / equivalent — **TBD**, its own future ADR."

This ADR makes that choice and specifies the surrounding architecture: how the IdP is bundled,
how it is isolated from the app database, and how a customer can swap it out for their own IdP
without touching the application code (BYOI — Bring Your Own IdP).

The target operator is an IT generalist running a self-hosted, Docker-composed instance
([[0015-deployment-model]]). Heavy operational overhead (JVM tuning, Python workers, Redis
clusters) is a deal-breaker at this scale.

## Considered options

- **Authentik** — mature, feature-rich, web UI, OIDC/SAML/LDAP. Stack: Django + Celery + Redis
  (Python + async workers). Operationally heavy for a 5–20-person IT team: Redis adds a
  stateful dependency, Celery workers require separate containers and tuning, Python image is
  large. Upstream projects like Authentik are designed for larger teams and introduce complexity
  that fights our "boring, durable, small-team operable" philosophy ([[0015-deployment-model]]).

- **Keycloak** — battle-tested, OIDC/SAML/LDAP. Stack: Java (Quarkus). The JVM adds memory
  pressure (300–500 MB baseline on a small VM), startup is slow, and the admin UI is notoriously
  complex for non-IAM specialists. Configuration is UI-first with little support for infra-as-code
  at small scale. Not a natural fit for the operator profile.

- **Zitadel** — modern, OIDC-first, Go binary. Single Docker container, low memory footprint,
  fast startup. Admin UI is clean and designed for human operators. Native support for
  `start-from-init` (bootstraps DB schema and first admin on first run — no separate migration
  step). Standard OIDC implementation. *(chosen)*

## Decision

### 1. Zitadel is the bundled default IdP

Zitadel (`ghcr.io/zitadel/zitadel:v2.68.0`, pinned) is the IdP shipped with the default
self-hosted setup. It is a service in the canonical root `compose.yaml` (an unprofiled backing
service for dev; tuned for prod under `--profile prod` + `infra/docker-compose.prod.yaml`). The
old `infra/docker-compose.prod.yml` was consolidated into this layout (see [[auth-zitadel-sot]] §9).

Image version is pinned for reproducibility. Upgrades are intentional (update the tag, test,
commit).

### 2. Zitadel gets its own PostgreSQL instance

Zitadel's database is isolated from the app database (`db` / `lazyit`). A separate `zitadel_db`
service runs `postgres:18-alpine` with its own volume (`zitadel_db_data`).

Rationale:

- **Schema isolation.** Zitadel performs aggressive schema migrations on startup. Sharing the
  app DB would risk migration conflicts and make independent schema version tracking impossible.
- **Independent backups.** The app DB and Zitadel DB have different backup cadences and
  retention policies. Operators can back them up independently.
- **Clean BYOI removal path.** When a customer brings their own IdP, they remove `zitadel` and
  `zitadel_db` from the compose file and delete `zitadel_db_data`. The app DB is completely
  unaffected. No data migration, no schema cleanup.

### 3. The backend speaks standard OIDC — BYOI by env vars

The lazyit API (NestJS) validates OIDC tokens using the standard OIDC discovery document
(`/.well-known/openid-configuration`). It does **not** use any Zitadel-specific API or SDK.

The integration is configured entirely by three environment variables:

```
OIDC_ISSUER=https://auth.yourdomain.com
OIDC_CLIENT_ID=<client id>
OIDC_CLIENT_SECRET=<client secret>
```

Swapping to Azure AD, Okta, Keycloak, or any other OIDC-compliant IdP requires changing these
three values and restarting the API. No code changes. This is the BYOI contract.

### 4. Routing — Zitadel on a subdomain via Caddy

Zitadel is served at `auth.{domain}` (e.g. `auth.lazyit.example.com`). Caddy adds a second
site block (`auth.{$LAZYIT_DOMAIN}`) that reverse-proxies to `zitadel:8080` on the internal
Docker network. Caddy auto-TLS covers the auth subdomain exactly as it covers the main domain
([[0026-reverse-proxy-tls]]).

This is a **separate site block**, not a path under the app domain. It avoids cookie/CORS
collision between the IdP and the app, and keeps auth traffic routing independently of the
app's same-origin `/api` routing.

### 5. TLS mode — Caddy terminates, Zitadel runs internal HTTP

Zitadel runs with `--tlsMode disabled` in both dev and prod. Caddy terminates TLS externally.

In prod, `ZITADEL_EXTERNALSECURE: "true"` and `ZITADEL_EXTERNALPORT: "443"` tell Zitadel it
is behind an HTTPS proxy, so it correctly generates HTTPS URLs in tokens and redirects. In dev,
`ZITADEL_EXTERNALSECURE: "false"` and `ZITADEL_EXTERNALPORT: "8080"` allow local HTTP operation.

### 6. First-run initialisation

Zitadel uses `start-from-init`: on the first start it initialises the DB schema and creates the
first admin user using `ZITADEL_FIRSTINSTANCE_ORG_HUMAN_USERNAME` and
`ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORD`. Subsequent restarts skip this if the instance
already exists. No separate migration step is needed.

The bootstrap procedure for registering the OIDC client is documented in
[[auth-bootstrap]].

## Consequences

- **Positive:**
  - Two new containers in the default setup: `zitadel` + `zitadel_db`. Both are on the
    internal Docker network; neither publishes a port in prod (ADR-0028).
  - Operators get a working IdP out of the box with a single `docker compose up`. No external
    service accounts, no SaaS dependency.
  - BYOI is zero-code: any OIDC IdP works by changing 3 env vars. Enterprise customers with
    Azure AD / Okta / Keycloak do not need a custom build.
  - Independent backup and removal path for the Zitadel DB.

- **Negative / trade-offs:**
  - DNS setup is required for the auth subdomain (`auth.{domain}`) before first deploy.
  - The `ZITADEL_MASTERKEY` must be backed up separately — losing it means losing access to
    Zitadel's encrypted data.
  - Memory overhead: Zitadel (Go binary) + its Postgres add ~150–200 MB at rest. Acceptable
    for the target VM size (1–2 GB minimum already required for the app stack).
  - The `X-User-Id` shim ([[0022-draft-visibility-auth-shim]], [[0024-asset-assignment-actor-shim]])
    is still in place until Phase 2 (API guard + OIDC token validation) is implemented.
    The current build remains unauthenticated; do not expose it publicly.

- **Follow-ups:**
  - **Phase 2 (backend):** implement the NestJS OIDC guard (validate JWTs from
    `OIDC_ISSUER`), replace the `X-User-Id` shim with real identity, provision `User.externalId`
    from the token `sub`.
  - **Phase 3 (frontend):** wire Auth.js (or equivalent) in the Next.js app.
  - Update [[deploy-self-hosted]] to reference the auth bootstrap step as a required
    prerequisite.
  - Zitadel image version policy: pin to a minor version, upgrade deliberately, test on a
    staging compose before promoting to prod.

Related: [[0016-auth-strategy-deferred]] · [[0015-deployment-model]] · [[0026-reverse-proxy-tls]] ·
[[0028-secrets-and-config]] · [[auth-bootstrap]] · [[deploy-self-hosted]]
