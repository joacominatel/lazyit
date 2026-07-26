---
title: "ADR-0087: Plain-HTTP-on-LAN deployment axis (host-agnostic) + start.sh --reconfigure"
tags: [adr, deployment, infra, security, auth]
status: accepted
created: 2026-07-05
updated: 2026-07-05
deciders: [Joaquín Minatel]
---

# ADR-0087: Plain-HTTP-on-LAN deployment axis (host-agnostic) + start.sh --reconfigure

## Status

**accepted** — 2026-07-05 (issue #1035). Closes the deferred follow-up named in
[[0086-local-authentication-mode]] §Non-goals ("plain-HTTP-on-LAN — a third, orthogonal deployment
axis"). Builds on the reverse-proxy/TLS model ([[0026-reverse-proxy-tls]]), the guided bootstrap
([[0047-guided-first-deploy-bootstrap]]) and the local-auth mode ([[0086-local-authentication-mode]]).
Amends the bare-IP `default_sni` note in [[0086-local-authentication-mode]] (#1010). **Scope: infra
only** — the app-side wiring (`AUTH_TRUST_HOST` ⇒ NextAuth `trustHost` + api CORS reflect-origin) is a
sibling change in `apps/web` / `apps/api`.

## Context

The observed reality of lazyit's target segment (small IT/Systems teams, 5–20): **most reach the app
by LAN IP or short hostname, over a switch they physically control, and do not have TLS.** ADR-0086
removed the mandatory-OIDC coupling (local auth is now first-class) but deliberately **kept the
internal-CA HTTPS default** and carved out plain-HTTP-on-LAN as a separate decision — because it is a
real security-posture choice (credentials in cleartext on the wire), not just "relax TLS."

Two concrete pains remain that this ADR closes:

1. **The deploy is pinned to one host.** `LAZYIT_SITE_ADDRESS` is a single hostname/IP; Caddy's site
   block only answers for that host and (for a hostname) mints a cert for it. On DHCP the LAN IP
   changes and the operator is locked out — Caddy no longer matches, `WEB_ORIGIN` breaks CORS/Auth.js,
   and there is **no supported reconfigure path**: `start.sh` is idempotent and, on a re-run with an
   existing `.env.prod`, SKIPS env regeneration and brings the stack up with the OLD (now-wrong) host.

2. **TLS on a trusted LAN is friction with little payoff.** The internal-CA cert triggers a browser
   warning on every client and does not cover a bare IP without `default_sni` gymnastics (#1010). For a
   team on a LAN they trust, plain HTTP "just works" and is the pattern of comparable self-hosted tools.

**Key infra finding:** Caddy already serves host-agnostic plain HTTP with **zero Caddyfile changes**.
A **port-only site address** (`LAZYIT_SITE_ADDRESS=:80`) makes the single `{$LAZYIT_SITE_ADDRESS}` block
listen on that port for **any** `Host`, with **no** automatic HTTPS, **no** cert request and **no**
http→https redirect. Verified with `caddy validate`:

```
$ LAZYIT_SITE_ADDRESS=":80" caddy validate --config infra/caddy/Caddyfile
... "server is listening only on the HTTP port, so no automatic HTTPS will be applied ..."
Valid configuration
```

The existing compose `${LAZYIT_HTTP_PORT:-8080}:80` mapping already publishes that `:80` listener on the
operator's chosen host port — so a bare-IP client reaches `http://<this-host>:<port>` regardless of
which IP the box currently holds. The global `default_sni {$LAZYIT_SITE_ADDRESS:localhost}` is a no-op
in this mode (no TLS app is generated), so it is harmless.

## Considered options

**(1) Do nothing — keep HTTPS-only, tell operators to pin a static IP / DNS name.** ❌ Excludes the
common DHCP LAN case and offers no lockout recovery.

**(2) A new "LAN" compose overlay + a second Caddy site block for `:PORT`.** ❌ Unneeded machinery — the
single existing site block already does host-agnostic HTTP with a port-only address. Compose `ports`
lists also can't be *removed* by an overlay (they merge), so an overlay wouldn't even help.

**(3) A third network/TLS mode chosen at install (chosen).** Add a **deployment-TLS axis** — `lan` |
`local` | `real` — orthogonal to `AUTH_MODE`, selected at Q1 of `start.sh`. `lan` sets a **port-only
site address** (host-agnostic plain HTTP), `AUTH_TRUST_HOST=true` and leaves `WEB_ORIGIN` unset; it
**requires** `AUTH_MODE=local`. Plus a **`--reconfigure`** path that re-renders `.env.prod` for a new
host/port/mode while **preserving every secret**, for the "my IP changed / switch mode" case.

## Decision

### 1. Three network/TLS modes (a new axis, orthogonal to AUTH_MODE)

Chosen at install (Q1 of `start.sh`). The operator **chooses** — `lan` is the easy interactive pick
(with the warning shown), never a silent default; `--yes` keeps the historical `localhost` smoke test.

| mode | `LAZYIT_SITE_ADDRESS` | TLS | `WEB_ORIGIN` | `AUTH_TRUST_HOST` | `AUTH_MODE` |
| --- | --- | --- | --- | --- | --- |
| **lan** | `:80` (PORT-ONLY, any-host) | none (plain HTTP) | **unset** | **`true`** | **`local`** (required) |
| **local** | `localhost` | internal-CA HTTPS (high ports) | `https://localhost:<https>` | unset | local or oidc |
| **real** | FQDN | Let's Encrypt / internal CA | `https://<domain>` | unset | local or oidc |

`local` and `real` are **unchanged** from before this ADR. `lan` is new.

**The env contract (shared with the app agents).** `AUTH_TRUST_HOST=true` ⇒ (web) NextAuth
`trustHost:true` so the app derives its base URL from the forwarded `Host`; (api) CORS **reflects the
request `Origin`** instead of pinning `WEB_ORIGIN`. `start.sh` emits `AUTH_TRUST_HOST` into `.env.prod`;
the **api** reads it via `env_file`, the **web** always trusts the host because it only ever runs behind
Caddy. With `WEB_ORIGIN` unset and a port-only Caddy listener, a DHCP IP change needs **no** re-render.

### 2. lan REQUIRES local auth

OIDC (bundled Zitadel or BYOI) bakes a **fixed `externalDomain`/issuer** at first boot and embeds it in
tokens and redirect URIs — it **cannot** be host-agnostic. So `lan` is only offered with
`AUTH_MODE=local` (`start.sh` forces it and a render-time check refuses any other combination). This is
orthogonal to — not implied by — `AUTH_MODE=local`: a local-auth deploy may still choose `local` or
`real` TLS. Together, local auth + `lan` deliver the "just works on a LAN" experience ADR-0086 foresaw.

### 3. `start.sh --reconfigure` (the supported "my IP changed / switch mode" path)

Re-runs the network-mode / host / ports questions on an **existing** install and re-renders
`.env.prod`, **preserving every secret already in the file** (`WORKFLOW_SECRET_KEY`, `AUTH_SECRET`,
`SESSION_SIGNING_SECRET`, DB creds — read back with the existing line-preserving reader, **never
regenerated**) and touching **no** volumes, then brings the stack up. It reuses the existing
render+validate pipeline; only the host/port/mode answers change.

- **Auth mode stays immutable** (ADR-0086): `--reconfigure` is supported **only for `AUTH_MODE=local`**
  installs. An OIDC install is **refused** with guidance — re-homing a Zitadel/BYOI deploy is a data
  operation (baked `externalDomain`), not an env re-render. Postgres topology and the auth mode are
  preserved, not re-asked.
- A leave-behind offline test (`infra/test/reconfigure-preserves-secrets.sh`) asserts the invariant:
  every secret survives a `--reconfigure` byte-for-byte.

## Consequences

### Security posture (the honest downgrade)

- **The login session travels UNENCRYPTED on the LAN in `lan` mode.** Anyone who can sniff the segment
  (mirror port, ARP spoof, rogue AP) sees the session token and can replay it. `start.sh` prints this
  plainly and the mode is scoped to a **trusted LAN** — never the public internet. `local`/`real`
  (HTTPS) remain the default recommendation for anything less than a physically-trusted network.
- **The secret vault stays zero-knowledge regardless** ([[0061-secret-manager-zero-knowledge]], INV-10):
  vault items are end-to-end encrypted with a **separate** passphrase the server never receives, so even
  over plain HTTP a sniffed session grants **no** access to vault plaintext. This is the mitigation that
  makes `lan` acceptable for the segment. Operators should still not reuse the login password as the
  vault passphrase (doubly true over HTTP).
- **`trustHost` footgun.** `AUTH_TRUST_HOST=true` makes the app trust the incoming `Host` header. It is
  safe **only** because api/web sit behind Caddy on a private Docker network and are **never** published
  directly. Do **not** expose the app containers to the host/LAN with this on — Caddy is the only hop.
  (Caddy's `trusted_proxies static private_ranges` already ensures a forged `X-Forwarded-For` is dropped.)

### Browser APIs: `lan` mode is an INSECURE CONTEXT (added 2026-07-26, #1125)

The consequence that bit us twice in production before it was written down: a page served over plain
HTTP on an IP is **not a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)**,
so a whole family of browser APIs is simply `undefined` there. `localhost` **is** a secure context, so
**development never reproduces this** — the failure only appears on a real `lan` install.

**Banned in `apps/web` feature code** (enforced by the `lazyit/no-secure-context-only-crypto` block in
`apps/web/eslint.config.mjs`, `error` severity):

| API | Use instead |
| --- | --- |
| `crypto.randomUUID()` | `nextListKey()` from `@/lib/list-key` for React list keys — keys need sibling-uniqueness, not entropy. For a real domain id, let the API mint it (`cuid()`). |
| `crypto.subtle.*` | The already-installed pure-JS `@noble/hashes` / `@noble/ciphers` primitives. |
| `navigator.clipboard.writeText()` | `copyText()` from `@/lib/secret-manager/clipboard` — it returns a boolean so the UI can offer a manual-copy fallback instead of a silent no-op (#813). |

`crypto.getRandomValues()` is **fine** — it is available in insecure contexts, which is why the
zero-knowledge vault (`@noble/*` + `getRandomValues`) keeps working in `lan` mode as claimed above.

Known history of this class: #813 (clipboard silently no-ops — a Copy that looked like it saved the
recovery key but didn't), #1125 (`crypto.randomUUID` crashed the workflow step editor on mount, making
the builder unusable), #1126 (`crypto.subtle` — TOTP secret items still dead in `lan` mode, open).

### Infra

- **Caddyfile: no functional change.** A port-only `LAZYIT_SITE_ADDRESS` (`:80`) already yields
  host-agnostic plain HTTP (verified). Only a documentation comment was added.
- **compose: one change** — `AUTH_URL: ${WEB_ORIGIN:-}` on the web service (was `${WEB_ORIGIN}`) so an
  unset `WEB_ORIGIN` in `lan` mode doesn't trip a compose warning; empty `AUTH_URL` ⇒ NextAuth derives
  the origin from the Host. Caddy's `${LAZYIT_HTTP_PORT}:80` mapping is reused as-is. In `lan` mode the
  `${LAZYIT_HTTPS_PORT}:443` mapping is still published but **idle** (Caddy serves HTTP only); compose
  port lists can't be conditionally dropped, so this bound-but-unused port is an accepted wart
  (`check_free_port` keeps it from failing the bring-up).
- **`.env.prod.example`** documents the three site-address shapes, `AUTH_TRUST_HOST`, and the lan
  contract.

## Non-goals

- **HTTPS on a bare IP without a cert warning** — out of scope; that needs a real CA or a trusted
  internal CA distributed to clients (`real` mode territory).
- **mDNS / auto-discovery of the host** — the operator reaches the box by its LAN IP or hostname.
- **Reconfiguring an OIDC deploy's host** — refused (baked `externalDomain`); a manual, documented
  data operation, not part of `--reconfigure`.
- **MFA / at-rest changes** — unaffected; inherited from ADR-0086.
