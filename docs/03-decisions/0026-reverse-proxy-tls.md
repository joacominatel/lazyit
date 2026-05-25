---
title: "ADR-0026: Reverse proxy & TLS (Caddy), same-origin /api routing"
tags: [adr, infra, proxy, tls]
status: accepted
created: 2026-05-25
updated: 2026-05-25
deciders: [Joaquín Minatel]
---

# ADR-0026: Reverse proxy & TLS (Caddy), same-origin /api routing

## Status

accepted

## Context

The prod-like and self-hosted topologies ([[0025-containerization-strategy]]) need one HTTPS entry
point in front of the web (`:3000`) and API (`:3001`) containers, for both **local prod-like**
(self-signed/internal CA) and **a real domain** (publicly trusted certs). Two coupled questions:

1. **Which reverse proxy** — for a small, self-hosted, single-org product ([[0015-deployment-model]]).
2. **How the browser addresses the API.** The web makes **all** API calls client-side (every
   `apiFetch` importer is `"use client"`) and reads `NEXT_PUBLIC_API_URL`, which Next.js **inlines
   at build time** into the client bundle. So the value is baked into the web image — a problem for a
   product meant to run on *unknown customer domains*.

## Considered options

**Proxy:** Caddy vs Traefik vs nginx.
- **Caddy** *(chosen)* — single static binary, tiny Caddyfile, **automatic HTTPS**: internal CA for
  local, Let's Encrypt for a real domain, no certbot. Best fit for "boring, small-team operable".
- **Traefik** — powerful Docker-label routing and a dashboard, but more moving parts and config than
  this scale needs.
- **nginx** — ubiquitous but manual TLS (certbot), verbose config, no auto-HTTPS.

**Routing / `NEXT_PUBLIC_API_URL`:** subdomain split vs same-origin path.
- **Subdomain split** (`app.` / `api.`) — clean routing, Swagger untouched, but `NEXT_PUBLIC_API_URL`
  is an absolute URL baked at build → **a rebuild per domain** and two DNS names + certs.
- **Same-origin `/api` (chosen)** — `NEXT_PUBLIC_API_URL=/api` (relative). The browser calls
  `/api/...` on the same origin; the proxy routes it to the API. **One image works on any domain**
  (no rebuild), and there is **no cross-origin request → CORS is moot**.

## Decision

- **Caddy** (`caddy:2-alpine`) is the reverse proxy and TLS terminator. Domain comes from
  `LAZYIT_DOMAIN` (default `localhost` for prod-like). Caddy's internal CA covers local; a real
  domain gets Let's Encrypt automatically. HTTP→HTTPS redirect is automatic.
- **`NEXT_PUBLIC_API_URL=/api`** (relative) is baked into the web image, making it domain-portable.
- **Caddy routing** (order matters — first match wins):
  1. `handle /api/docs*` → `reverse_proxy api:3001` **without** stripping (Swagger lives at the
     API's own `/api/docs` and `/api/docs-json`).
  2. `handle_path /api/*` → strips the `/api` prefix → `reverse_proxy api:3001` (so `/api/users`
     reaches the API's root `/users`; the API mounts its routes at root, not under `/api`).
  3. everything else → `reverse_proxy web:3000`.
- **Ports:** prod-like publishes Caddy on **`8080`/`8443`** (high ports, no root needed) so it never
  clashes with dev (`3000`/`3001`/`5432`). API, web and Postgres are **not published** — they live on
  the internal compose network only.
- The API's `WEB_ORIGIN` is set to the site URL; with same-origin requests CORS is not exercised, but
  the value stays correct for any direct/legacy cross-origin call.

## Consequences

- **Positive:** one domain-portable web image (key for distributable self-hosted); no CORS surface;
  automatic HTTPS local and prod; minimal config; the API's container ports never touch the host.
- **Trade-offs:** Swagger needs the dedicated non-stripping rule (a small special case); a future API
  route literally beginning with `docs` would collide with the Swagger rule (none exists today);
  the relative-URL approach assumes web and API share an origin (true by construction here).
- **Follow-ups:** the future IdP gets a **commented** route stub in the Caddyfile and placeholder env
  ([[0016-auth-strategy-deferred]]); a real-domain deployment is documented in the deploy runbook.

Related: [[0025-containerization-strategy]] · [[0015-deployment-model]] · [[0016-auth-strategy-deferred]] ·
[[0018-api-documentation-swagger]] · [[deployment]]
