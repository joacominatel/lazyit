---
id: SEC-083
title: `/mcp` query-token revocation runs unbounded DB lookups for anonymous callers, before the MCP-off 404 and every rate limit
severity: low
status: closed
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

## Resolution

**Status**: fixed
**Fixed in**: commit `72e45a7e` (`fix(api): bound the /mcp query-token scan behind the per-IP limiter (SEC-083)`)
**Fixed by**: lazyit-remediator
**Date**: 2026-09-25

### Changes
- `apps/api/src/mcp/mcp-auth.guard.ts`: a request that carries query credentials is charged to the per-IP refused-authentication limiter (`MCP_AUTH_FAILURE_RATE_LIMIT`, 30 per minute) before the scan. An address over the limit gets no scan. The limiter is in memory and never touches the DB, so an instance with MCP off still reads nothing for it. The 404 and 400 answers are unchanged, and a query-credential request now also counts toward the bearer-path block.
- `apps/api/src/mcp/mcp-exposed-token.service.ts`: a value is a candidate only when it matches the exact credential grammar: a revocable prefix plus the fixed 43-character base64url body, or a parsable `lzit_sa_` token. At most `MCP_QUERY_TOKEN_SCAN_MAX` (4) distinct candidates are examined, and the opaque ones are looked up with one `findMany({ tokenHash: { in } })`, with at most one revoke per distinct grant. Revoke-on-sight (G3 F1) holds for any real token.
- `apps/api/src/oauth/oauth-crypto.ts`: `hasOpaqueTokenShape(value, prefix)`, derived from `SECRET_BYTES`, the only length ever minted.
- `apps/api/src/mcp/mcp.constants.ts`: `MCP_QUERY_TOKEN_SCAN_MAX = 4`.
- `docs/ai-assistant/{mcp-and-oauth,security}.md` are updated.

### Tests added
- `apps/api/src/mcp/mcp-auth.guard.spec.ts`::"bounds the query-token scan: 200 values cost at most one lookup, even while MCP is off (SEC-083)". It fails without the fix with 200 lookups.
- `…`::"never looks up a value that is not token-shaped (SEC-083)". It fails without the fix with 3 lookups.
- `…`::"charges the per-IP limiter and skips the scan once the address is over it (SEC-083)". It fails without the fix.
- `…`::"still revokes a real exposed token sent alongside malformed junk (SEC-083)" is a regression guard for G3 F1.
- `apps/api/src/oauth/oauth-crypto.spec.ts`::"hasOpaqueTokenShape — the exact grammar of a minted token (SEC-083)".

### Verification
The three SEC-083 tests fail with the pre-fix guard and service (200 and 3 lookups, and a scan while blocked) and pass with the fix. The full API Jest suite passes (5864, under Node). `tsc` passes for all four projects, and scoped eslint is clean.

### Residual risk
An attacker who puts four well-formed fake tokens before a real exposed token can stop that request from revoking it. The real token was still refused, and the attacker would have to hold it already. The limiter is per replica (the accepted `/mcp` posture). A leaked token that arrives from an address already over its limit is not revoked on that request, but it is still refused.
