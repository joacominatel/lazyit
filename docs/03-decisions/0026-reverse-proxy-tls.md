---
title: "ADR-0026: Reverse proxy & TLS (Caddy), same-origin /api routing"
tags: [adr, infra, proxy, tls]
status: accepted
created: 2026-05-25
updated: 2026-09-23
deciders: [Joaquín Minatel]
---

# ADR-0026: Reverse proxy & TLS (Caddy), same-origin /api routing

## Status

accepted

**Amended 2026-08-20 (issue #1250):** the `/api/auth/*` prefix is shared between Auth.js (web) and
the API's local-auth password endpoints (ADR-0086 §F4b). Only Auth.js's own action paths are
excluded from the API route; everything else under `/api/*` — including the API's `/api/auth/*`
endpoints — reaches the API. See the routing rules below.

**Amended 2026-09-23 (issue #1322, [[0097-ai-assistant-mcp-and-headless-api]]):** two changes for
external AI agents and streamed responses.

- **Unprefixed API routes.** MCP clients and OAuth discovery address the bare origin, so a short
  allowlist reaches the API **without** the `/api` strip: `/mcp`, `/.well-known/oauth-protected-resource*`,
  `/.well-known/oauth-authorization-server*`, `/oauth/token`, `/oauth/register` and `/oauth/revoke`.
  `/oauth/authorize` is the consent page and stays on web; nothing else under `/oauth/*` or
  `/.well-known/*` is the API's. See routing rule 3 below.
- **Streams skip `encode`.** Every response is still compressed (`zstd gzip`) **except** streamed ones,
  and the carve-out is matched on the **request**: `/mcp`, `/api/ai/runs/*/events`, and any request
  with `Accept: text/event-stream`. The reason: the pinned Caddy (v2.11.3) `encode` holds back the
  response header until the first body write and compresses `text/event-stream` (its default match
  includes `text/*`), so an SSE response arrived late and compressed (caddyserver/caddy#6293). The
  fix, caddyserver/caddy#7905, is in no release as of v2.11.4. A response `match` list cannot help,
  because the wrapper is in place before the content type is known. Revisit this when the pin moves
  to a release that contains #7905.

**Amended 2026-09-25 (issue #1315, W4-3 finding F1):** the unprefixed allowlist also carries the paths
MCP SDK clients **probe** when the RFC 8414 metadata is missing (always on `lan`) — OIDC discovery
`/.well-known/openid-configuration*` and the root fallbacks `/authorize`, `/token`, `/register`. The API
serves none of them (OAuth only, no OIDC), so they answer its JSON 404; on the web app they 302'd to
`/login` HTML and a client failed on `Unexpected token '<'` instead of its designed refusal. The web app
owns none of these paths (its consent page is `/oauth/authorize`). See routing rule 3 below.

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
  1. `/api/*` except the Auth.js action paths below → `reverse_proxy api:3001`, stripping the
     `/api` prefix (so `/api/users` reaches the API's root `/users`; the API mounts its routes at
     root, not under `/api`). `/api/docs*` is **not** forwarded separately (SEC-009): it falls
     here, the API does not serve the stripped path → 404.
  2. Auth.js action paths (`/api/auth/{providers,session,csrf,signin,signout,callback/*,
     verify-request,error,webauthn-*}`) → `reverse_proxy web:3000` — the web app owns that
     namespace ([[0039-authjs-v5-frontend-oidc]]). Everything else under `/api/auth/*` — the API's
     own local-auth password endpoints (`/api/auth/change-password`, `/api/auth/forgot-password`,
     `/api/auth/reset-password`, ADR-0086 §F4b) — falls to rule 1 → the API (issue #1250).
  3. `/mcp`, `/.well-known/oauth-protected-resource*`, `/.well-known/oauth-authorization-server*`,
     `/oauth/token`, `/oauth/register`, `/oauth/revoke` → `reverse_proxy api:3001` **unstripped**
     (the external-agent surface, [[0097-ai-assistant-mcp-and-headless-api]]; the API answers 404
     while MCP is off, and on `lan` for the OAuth rows). Also, so a probing client gets a JSON 404 and
     not the web's `/login` HTML: `/.well-known/openid-configuration*`, `/authorize`, `/token`,
     `/register` — paths the API never serves (amendment 2026-09-25).
  4. everything else — including `/oauth/authorize` — → `reverse_proxy web:3000`.
- **Compression:** `encode zstd gzip` applies to every response except streamed requests (`/mcp`,
  `/api/ai/runs/*/events`, `Accept: text/event-stream`), which pass unbuffered and uncompressed
  (amendment 2026-09-23).
- **Ports:** prod-like publishes Caddy on **`8080`/`8443`** (high ports, no root needed) so it never
  clashes with dev (`3000`/`3001`/`5432`). API, web and Postgres are **not published** — they live on
  the internal compose network only.
- The API's `WEB_ORIGIN` is set to the site URL; with same-origin requests CORS is not exercised, but
  the value stays correct for any direct/legacy cross-origin call.

## Consequences

- **Positive:** one domain-portable web image (key for distributable self-hosted); no CORS surface;
  automatic HTTPS local and prod; minimal config; the API's container ports never touch the host.
- **Trade-offs:** `/api/docs*` is not proxied in prod (SEC-009) — Swagger is internal/dev only. The
  `/api/auth/*` prefix is shared by Auth.js (web) and the API's local-auth endpoints; the Caddyfile
  excludes only Auth.js's action paths, so a NEW API route under `/api/auth/*` reaches the API
  automatically (issue #1250). The relative-URL approach assumes web and API share an origin (true
  by construction here).
- **Follow-ups:** the future IdP gets a **commented** route stub in the Caddyfile and placeholder env
  ([[0016-auth-strategy-deferred]]); a real-domain deployment is documented in the deploy runbook.

Related: [[0025-containerization-strategy]] · [[0015-deployment-model]] · [[0016-auth-strategy-deferred]] ·
[[0018-api-documentation-swagger]] · [[0097-ai-assistant-mcp-and-headless-api]] · [[deployment]]
