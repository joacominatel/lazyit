---
id: SEC-010
title: Setup rate-limit + first-run audit IP key on the spoofable leftmost X-Forwarded-For
severity: low
status: fixed
cwe: CWE-348
discovered: 2026-06-02
module: config
tags: [rate-limit, spoofing, trust-boundary, hardening, infra]
---

# SEC-010 — Forgeable X-Forwarded-For defeats the /config/setup per-IP rate-limit (and audit IP)

## Summary

The first-run setup rate-limiter and the setup audit IP both derive the client identity from the
**leftmost** `X-Forwarded-For` hop. Caddy *appends* the real peer IP (it had no `trusted_proxies`), so
a caller can put any value first — rotating it per request mints a fresh rate-limit bucket each time,
trivially bypassing the 5/min cap on the public `POST /config/setup`, and forging the first-run audit IP.

## Description

Two call sites read the same untrusted token:

- `apps/api/src/config/setup-rate-limit.guard.ts` `clientKey()` — `first?.split(',')[0]?.trim()` of
  the inbound `x-forwarded-for`, used as the rate-limit bucket key.
- `apps/api/src/config/config.controller.ts` `clientIp()` — the identical expression, used as the IP
  recorded in the first-run setup audit.

`X-Forwarded-For` is a client-controllable request header. A reverse proxy that **appends** (Caddy's
default) produces `XFF = <client-claimed>, <real-peer>`, so `split(',')[0]` is whatever the *client*
sent. `SetupRateLimitGuard` keys its in-memory bucket on that value:

```ts
// before
const xff = first?.split(',')[0]?.trim();
return xff || request.ip || request.socket?.remoteAddress || 'unknown';
```

So `X-Forwarded-For: <random>` on each request lands in a different bucket — the per-IP cap
(`MAX_ATTEMPTS = 5` / 60 s) never accumulates. The same forgery sets an arbitrary audited IP on the
admin-creation record. The root cause is a **trust-boundary** error (CWE-348, *use of less-trusted
input*): the app trusts a hop the proxy never verified, because Caddy was not told which proxies are
trusted and the app did not constrain how `req.ip` is derived from `XFF`.

## Impact

Low, scoped to `POST /config/setup` (the public, pre-login first-run surface, gated by an idempotent
any-ADMIN 409 + a CSRF token + this rate-limit — ADR-0043 §6 / Fork #7). The rate-limit is the
brute-force/abuse backstop on that one privileged endpoint; defeating it removes the throttle on
racing the first-ADMIN creation and on hammering CSRF/validation. The forged audit IP weakens the
first-run forensic record. No data disclosure or authz bypass; the CSRF + idempotent gate still stand.

## Proof of concept

Reasoned from the code, **not executed** (the stack is not run during review). Against a deployment
built before this fix, behind Caddy:

```sh
# Each request carries a fresh forged leftmost hop, so each lands in a new bucket — no 429 ever.
for i in $(seq 1 50); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<site>/api/config/setup \
    -H "X-CSRF-Token: <token>" -H "X-Forwarded-For: 10.0.0.$i" \
    -H 'Content-Type: application/json' -d '{"email":"a@b.c","firstName":"A","lastName":"B"}'
done
```

## Affected

- `apps/api/src/config/setup-rate-limit.guard.ts` — `clientKey()` (rate-limit bucket key).
- `apps/api/src/config/config.controller.ts` — `clientIp()` (setup audit IP).
- `infra/caddy/Caddyfile` — no `trusted_proxies`, so Caddy appends rather than sanitises `XFF`.

## Recommendation

Establish a trusted client IP at the proxy and read it through Express's verified `req.ip`, then key on
that — never the raw header:

1. **Infra:** configure Caddy `trusted_proxies` (the private Docker ranges) at the `servers` global
   option, so Caddy trusts `XFF` only from private-range peers and otherwise uses the real connecting
   IP — a forged leftmost hop from the public client is dropped.
2. **App:** set Express `app.set('trust proxy', <hops>)` (Caddy = 1 hop) via a `TRUST_PROXY` env, so
   `req.ip` is the verified client. Leave it OFF when no proxy is present (dev) — then `req.ip` is the
   socket address and a spoofed `XFF` is ignored entirely.
3. Key **both** the rate-limiter and the setup audit on `req.ip` (fall back to the socket address).

## Prevention

Make "never key security decisions on a raw `X-Forwarded-For`; always go through `req.ip` with an
explicit `trust proxy`, and set `trusted_proxies` at the proxy" a review rule. A `trust proxy` value
must accompany any proxy deployment; the safe default is OFF (ignore `XFF`).

## References

- CWE-348: Use of Less Trusted Source. CWE-290: Authentication Bypass by Spoofing.
- Express `trust proxy` / `req.ip` semantics · Caddy `trusted_proxies` (servers global option).
- [[0043-first-run-setup]] / Fork #7 (the rate-limited public setup surface) · ADR-0026/0037 (Caddy).

## Resolution

**Status**: fixed
**Fixed in**: commit `<guard>` (`fix: key setup rate-limit on verified req.ip, not leftmost XFF (SEC-010)`)
· commit `<controller>` (`fix: key setup audit IP on verified req.ip (SEC-010)`)
· commit `<main.ts>` (`fix: set Express trust proxy from TRUST_PROXY (SEC-010)`)
· commit `<trust-proxy.ts>` (`feat: TRUST_PROXY parser`)
· commit `<Caddyfile>` (`fix: trusted_proxies + drop public /api/docs* [CTO-authorized infra]`)
**Fixed by**: lazyit-remediator
**Date**: 2026-06-02

### Changes

- `apps/api/src/config/setup-rate-limit.guard.ts`: `clientKey()` now returns
  `request.ip || request.socket?.remoteAddress || 'unknown'` — the verified client, never the raw
  leftmost `XFF` token.
- `apps/api/src/config/config.controller.ts`: `clientIp()` likewise returns `req.ip || socket addr`.
- `apps/api/src/common/trust-proxy.ts` *(new)*: `parseTrustProxy(raw)` maps the `TRUST_PROXY` env to
  Express's `trust proxy` value — `false` when unset/blank/`false`/`0` (dev default: ignore `XFF`), a
  positive integer = that many trusted proxy hops (Caddy = 1), `true` for all hops; invalid input
  fails closed to `false`. Pure + isolated so it unit-tests without dragging the AppModule graph.
- `apps/api/src/main.ts`: the app is created as `NestExpressApplication` and
  `app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY))` so `req.ip` is the verified client.
- `infra/caddy/Caddyfile` *(CTO-authorized cross-lane infra edit)*: added
  `servers { trusted_proxies static private_ranges }` to the global options — Caddy trusts `XFF` only
  from private-range peers (the Docker network) and uses the real connecting IP otherwise, so a public
  caller's forged `XFF` is dropped and the value forwarded to the API is trustworthy.
- `infra/env/.env.prod.example` *(infra)*: `TRUST_PROXY=1` (behind Caddy = one hop).
- `apps/api/.env.example`: documents `TRUST_PROXY` (commented; dev leaves it off).

### Tests added

- `apps/api/src/config/setup-rate-limit.guard.spec.ts`::"a forged X-Forwarded-For does NOT rotate the
  bucket — same req.ip is still capped (SEC-010)" — sends a **different** spoofed leftmost `XFF` on
  each of 6 requests while `req.ip` stays one real client; asserts the 6th still 429s. **Fails without
  the fix** (the old `clientKey` keyed on the rotating `XFF` token, so every request minted a fresh
  bucket and none reached the cap — all 6 would return `true`).
- `apps/api/src/config/config.controller.spec.ts`::"a rotating forged X-Forwarded-For does NOT bypass
  the cap through the real pipeline (SEC-010)" — same property through the **real** Nest HTTP pipeline
  (`@UseGuards(SetupRateLimitGuard)`, `trust proxy` off as in dev): 5 × 201 with rotating forged `XFF`,
  6th → 429, and the service is not called a 6th time.
- `apps/api/src/common/trust-proxy.spec.ts`::parseTrustProxy — the env→value mapping (default false,
  positive-int hop count, `true`, fail-closed on garbage).

### Verification

- `apps/api` jest (real jest, userland Node): the three specs above pass; full suite 57 suites /
  700 tests green.
- Strict `bunx tsc -p apps/api/tsconfig.json --noEmit` clean (incl. the `NestExpressApplication` cast).
- `apps/api` `nest build` green.
- Caddy `trusted_proxies static private_ranges` is doc-verified against the Caddy servers global
  option (the `caddy` binary is absent in the review sandbox to run `caddy adapt`).

### Residual risk

The `X-User-Id` auth shim is still forgeable (DEF-002, dev-only) — orthogonal to this fix, which only
hardens the proxy→app client-IP trust boundary. The rate-limiter remains in-memory + per-instance (by
design for a single-instance first-run; a multi-replica wizard would want a shared store — out of
scope). If a deployment puts the API behind a *different* number of proxy hops than Caddy's one,
`TRUST_PROXY` must be set to match, or `req.ip` will be wrong; the env doc states this.
