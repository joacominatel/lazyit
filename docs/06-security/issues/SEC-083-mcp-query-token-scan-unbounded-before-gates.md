---
id: SEC-083
title: `/mcp` query-token revocation runs unbounded DB lookups for anonymous callers, before the MCP-off 404 and every rate limit
severity: low
status: open
cwe: CWE-770
discovered: 2026-09-25
module: mcp
tags: [mcp, dos, anonymous, rate-limit]
---

# SEC-083 — Unbounded, ungated query-token scan on `/mcp`

## Summary

Before any other check, `McpAuthGuard` passes every `access_token` / `token` query value to
`McpExposedTokenService.handle`. For each distinct value with a lazyit token prefix, it runs a sequential
database lookup. There is no cap on the number of values, and it runs before the shim/MCP-off 404 and
before the per-IP auth-failure limiter. One anonymous request therefore causes hundreds of queries, even
on an instance where MCP is switched off (the default).

## Description

- `mcp-auth.guard.ts:112` calls `this.exposed.handle(queryTokens, ip)` first. The capability gate is at
  `:115-117` and the IP limiter at `:133`.
- `queryTokensOf` collects every value of every case variant of the credential parameters
  (`mcp-auth.guard.ts:361-376`).
- `handle` loops over `new Set(values)` with an `await` per value (`mcp-exposed-token.service.ts:38`).
  For any value starting with `lzit_oat_`, `lzit_ort_` or `lzit_pat_` it hashes the value and runs
  `oAuthToken.findUnique` with nested includes (`:62-74`). No length or charset check filters out values
  that cannot be real tokens.
- The query parser allows up to 1000 pairs. The request-line size (Node's 16 KiB header limit) caps a
  request at roughly 800 distinct `token=lzit_pat_N` values.

The G3 F1 decision to revoke an exposed credential on sight, whatever the MCP switch, is sound. What is
missing is a bound. The documented order (security.md §6.3, INV-AI-12: "off by default means no new
anonymous surface", "404 … before anything else is read") does not hold for this step.

## Impact

Anonymous resource amplification: each request holds a pooled DB connection for about 800 indexed
lookups, run one after another. A modest number of concurrent requests can exhaust Prisma's connection
pool and slow the whole API. No data is exposed and nothing is revoked unless the attacker already has the
token. Low, since it causes only degradation and the lookups are cheap indexed reads.

## Proof of concept

Reasoned from the code, not executed.

```
q=$(seq 1 800 | sed 's/^/token=lzit_pat_/' | paste -sd'&')
for i in $(seq 1 50); do curl -s "https://lazyit.example/mcp?$q" -o /dev/null & done
# Each request: ~800 sequential findUnique calls, then 404 (MCP off) or 400.
```

## Affected

- `apps/api/src/mcp/mcp-auth.guard.ts:110-117`, `:361-376`
- `apps/api/src/mcp/mcp-exposed-token.service.ts:36-50`, `:52-97`

## Recommendation

- Bound the scan: consider at most a few distinct values (for example 4), and only those that match the
  exact token grammar (prefix plus the fixed-length base64url body `mintOpaqueToken` produces). Ignore the
  rest.
- Charge the IP limiter first: call `rateLimiter.authFailure(ip)` for each request that carries query
  credentials, and skip the scan when `authBlocked(ip)`.
- Optionally, look up all remaining hashes with a single `findMany({ where: { tokenHash: { in } } })`.

## Prevention

Every pre-authentication step that reaches the database needs a hard bound on work per request and must
sit behind a per-IP limiter. Add a test that sends many query tokens and asserts at most N lookups.

## References

- CWE-770; OWASP API4:2023 (unrestricted resource consumption).
- `docs/ai-assistant/security.md` §6.3, INV-AI-12; `docs/ai-assistant/mcp-and-oauth.md` (G3 F1).
