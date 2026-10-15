---
id: SEC-092
title: The OAuth per-IP rate limiter scans every bucket on each hit, so the unauthenticated OAuth endpoints have quadratic CPU cost under an IP-rotating flood
severity: medium
status: open
cwe: CWE-407
discovered: 2026-10-10
module: oauth
tags: [dos, rate-limit, oauth, unauthenticated, algorithmic-complexity]
---

# SEC-092 — `FixedWindowRateLimiter.hit()` prunes the whole map synchronously on every request

## Summary

The per-IP limiter on `/oauth/token`, `/oauth/register` and `/oauth/revoke` walks its entire bucket map
on every hit to delete expired windows. The map is keyed by client IP and has no size cap, so a flood
from many source addresses grows it, and each request then costs time proportional to its size on the
single event loop. The whole API stalls, not just OAuth.

## Description

- `hit()` (`apps/api/src/oauth/oauth-rate-limit.ts:34-48`) iterates every bucket before reading its
  own key. Nothing bounds the number of buckets except window expiry; the class comment says
  "self-pruning so the map stays bounded" (`:17-21`), which holds for memory over time but not for
  per-request CPU.
- The key is the verified client IP (`:51-54`), one bucket per full address. An attacker holding an
  IPv6 /64 has 2^64 distinct keys.
- The guards sit on `@Public()` routes (`register.controller.ts:34-36`, `token.controller.ts:39-41`,
  `revoke.controller.ts:32-34`). Guards run before the handler, so the hit is counted even when MCP is
  off and the handler's `requireEnabled()` (`register.controller.ts:44`, `token.controller.ts:49`,
  `revoke.controller.ts:42`) would 404. Caddy routes these three paths to the API on every instance
  (`infra/caddy/Caddyfile:171`).
- The register window is one hour (`oauth.constants.ts:50`), so its buckets live that long; token and
  revoke use one minute (`:51-52`).
- The MCP auth-failure counter has the same full-map prune (`apps/api/src/mcp/mcp-rate-limit.ts:44-48`,
  AUD-039, Low: each request there also costs a DB lookup). The CIMD fetch limiter reuses this class but
  is keyed per signed-in user, so it is not reachable anonymously.

## Impact

Availability of the whole API. An unauthenticated attacker sending `POST /oauth/register` from
rotating source addresses grows the register map by one entry per address for an hour. At a few hundred
thousand entries, each further request does a full synchronous scan, the event loop saturates, and every
route (including `/health/ready` and the web's API calls) times out. Rated **Medium**: no data is
exposed and it needs a large address pool, but the endpoints are anonymous, reachable with MCP off, and
the cost is per request rather than per window.

## Proof of concept

Reasoned from code, **not executed** (the API is not run during review).

```sh
# From a host with an IPv6 /64 routed to it (addresses bound locally), one request per fresh source address:
for i in $(seq 1 500000); do
  addr="2001:db8:1:2:$(printf '%x:%x:%x:%x' $RANDOM $RANDOM $RANDOM $RANDOM)"
  curl -s --interface "$addr" -X POST https://lazyit.example/oauth/register \
    -H 'Content-Type: application/json' -d '{}' -o /dev/null &
done
# The register map reaches ~500k buckets; every later request scans all of them before answering.
```

## Affected

Verified on `dev` at `a4ca679ea`.

- `apps/api/src/oauth/oauth-rate-limit.ts:34-48` — the prune loop inside `hit()`.
- `apps/api/src/oauth/oauth-rate-limit.ts:76-101` — the register, token and revoke guards.
- `apps/api/src/oauth/oauth.constants.ts:50-52` — the windows.
- `apps/api/src/mcp/mcp-rate-limit.ts:44-48` — the same pattern on the MCP auth-failure path (AUD-039).

## Recommendation

Make a hit O(1): check and reset only the caller's own bucket when its window has expired, and sweep
expired buckets on a timer (or every Nth hit with a bounded batch). Add a hard size cap with
oldest-first eviction, so a flood degrades the limit rather than the process. Share one implementation
between the OAuth and MCP limiters. Optionally key IPv6 clients by their /64 so one allocation is one
bucket. No data change: the limiters are in-memory.

## Prevention

A unit test that `hit()` cost does not grow with the number of live buckets (for example, a large
pre-filled map and a bounded number of iterations per call), and a rule that every in-memory limiter
has a size cap.

## References

- CWE-407 Inefficient Algorithmic Complexity; CWE-770 Allocation of Resources Without Limits.
- [[mcp-and-oauth]] (the authorization server, DCR "unauthenticated endpoint to rate-limit") ·
  [[0097-ai-assistant-mcp-and-headless-api]].
- [[SEC-083-mcp-query-token-scan-unbounded-before-gates|SEC-083]] — an earlier pre-authentication cost
  bound on the MCP path.
- Sweep: [[sweep-2026-10-10-backend-audit]] (AUD-005).
