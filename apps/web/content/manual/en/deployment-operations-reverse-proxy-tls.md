---
title: Reverse proxy & TLS
order: 5
category: deployment-operations
subcategory: reverse-proxy-tls
---

# Reverse proxy & TLS

Every request to a lazyit instance arrives through **Caddy**, the reverse proxy. It terminates HTTPS,
routes traffic to the web app and the API, and is the **only** service that publishes ports to the
host. Everything else stays on the internal network.

## What Caddy does

- **Terminates TLS** and obtains certificates automatically (see below).
- **Routes by path on a single origin.** The browser calls one origin; Caddy sends page requests to
  the web app and requests under `/api/` to the API (stripping the `/api` prefix). Because everything
  is same-origin, one web image works on any domain.
- **Serves the identity provider** at the `auth.` subdomain of your domain, with its own certificate.
- **Adds baseline security headers** to every response and strips the server banner.

Caddy's configuration lives in `infra/caddy/Caddyfile`. For most deployments you don't edit it — you
set values in the environment file and, for a public domain, uncomment two lines.

## TLS: automatic certificates

Caddy provisions certificates with **zero configuration**, in one of two modes:

- **Internal certificate authority** — used for `localhost` and private deployments. The certificate
  is real TLS but not trusted by browsers by default, so you'll see a warning until you trust Caddy's
  root certificate. This is the mode for local prod-like testing and air-gapped/private networks.
- **Let's Encrypt** — used for a real, publicly reachable domain. Certificates are publicly trusted
  (no warning) and renew automatically. This requires your domain to resolve to the host and ports
  **80 and 443** to be reachable.

There is also a **no-TLS option** for a trusted LAN: the bootstrap's **LAN mode** serves plain **HTTP**
on any IP or hostname, with no certificate to provision or trust. Sessions are then unencrypted, so use
it only on a local network you control — see
[Network & TLS modes](/help/deployment-operations-self-hosting).

## Going live on a real domain

For a public, trusted-HTTPS deployment, set these in `infra/env/.env.prod`:

- Your **site address** to your fully-qualified domain name.
- Your **domain** (used to build the `auth.` subdomain for sign-in).
- The public origin URL (`https://yourdomain.com`, no trailing slash).
- An **ACME contact email** for Let's Encrypt — **and** uncomment the `email` line in the Caddyfile.
- The published **ports** to the standard `80` and `443` (the defaults are high ports for local
  testing).

For a real public domain, also enable **HSTS** by uncommenting the `import hsts` line in the
Caddyfile's site block. HSTS tells browsers to force HTTPS for a year.

> Only enable HSTS on a real, publicly-trusted domain. **Never** enable it on a `localhost` or
> internal-CA install — it would pin your browser to HTTPS-only for `localhost` across every project.

## Trusting the local certificate

On a local prod-like deploy, accept the browser warning, or trust Caddy's root certificate once. You
can export it from the running container:

```sh
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod \
  cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-local-root.crt
```

Then add `caddy-local-root.crt` to your operating system or browser trust store. On a real domain with
Let's Encrypt there is no warning and nothing to trust manually.

## A note on the API docs

The API's interactive docs page is **deliberately not** served on the public origin. A request to
`/api/docs` on a live instance returns **404** — that is intended hardening, not a broken install. The
docs remain reachable on the internal network and in local development.

## Trust and forwarded headers

Caddy sits as the single hop in front of the API and forwards the verified client IP. The API is
configured to trust exactly that one hop, so request-IP-based features (rate limiting, the first-run
audit) see the real client and not a forged header. This is preconfigured; you don't need to change it
for a standard single-host deploy.

## The AI assistant and external agents

Two things matter here once AI is turned on:

- **The chat streams its answers.** Caddy passes the stream through unbuffered and uncompressed. If you
  put **another proxy or load balancer in front of Caddy**, it must not buffer or compress
  `text/event-stream` either (nginx: `proxy_buffering off;` on the lazyit location) — otherwise each reply
  appears only once it is complete.
- **MCP sign-in needs HTTPS and a pinned address.** Caddy routes the MCP endpoint (`/mcp`) and the OAuth
  paths to the API. External AI agents sign in with OAuth only when the public origin (`WEB_ORIGIN`) is an
  `https://` address; on a plain-HTTP (LAN) instance they use personal tokens instead. A TLS proxy in
  front of a LAN-mode instance is not enough — set `WEB_ORIGIN` to the `https://` address and restart the
  API. Cloud connectors (claude.ai, ChatGPT) also need the instance reachable from the internet with a
  publicly trusted certificate. See [External AI agents (MCP)](/help/ai-assistant-setup#external-ai-agents-mcp).

## Content-Security-Policy

The web app sends its own **Content-Security-Policy** on every page. It is a second line of defence:
if something ever slipped past the sanitizing of Knowledge Base articles or AI answers, the browser
still refuses to run injected script or to load images and connections from other sites. Scripts are
allowed by a one-time value generated for each page, and images come only from lazyit itself.

Today the policy runs in **report-only** mode: the browser checks it and writes any breach to its
developer console as a `[Report Only]` message, but blocks nothing. Framing lazyit inside another
site is already **blocked** in every mode. A later version switches the policy to enforcing.

What this means for you:

- **Nothing to configure** with the bundled Caddy. The policy comes from the web app, not from Caddy.
- **Your own reverse proxy** in front of lazyit should **not add a second `Content-Security-Policy`**.
  Browsers apply every policy they receive, so a second one can block the scripts the app allows. If
  your organization requires one at the proxy, pass the app's header through unchanged instead.
- **Images from other sites don't load**, in articles or anywhere else — by design. Upload the image
  as an attachment to the article instead; attachments are served by lazyit itself.

## Related

- [Self-hosting](/help/deployment-operations-self-hosting)
- [Services](/help/deployment-operations-services)
- [Identity provider](/help/deployment-operations-identity-provider)
- [Troubleshooting](/help/deployment-operations-troubleshooting)
