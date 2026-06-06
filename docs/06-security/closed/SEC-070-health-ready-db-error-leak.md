---
id: SEC-070
title: Unauthenticated /health/ready leaks the raw DB driver error (internal host/port) on failure
severity: low
status: fixed
cwe: CWE-209
discovered: 2026-06-06
module: health
tags: [info-leak, error-handling, unauthenticated, exposure]
---

# SEC-070 — /health/ready echoes the raw Postgres connection error to anonymous callers

## Summary

`GET /health/ready` is `@Public()` (no token) and, when the DB check fails, returns the raw driver
error message in `checks.database.error` — a node-postgres connection failure typically embeds the
internal DB host/IP and port (e.g. `connect ECONNREFUSED 172.18.0.2:5432`), disclosing internal
topology to an unauthenticated caller.

## Description

`HealthService.checkDatabase()` runs `await this.prisma.$queryRaw\`SELECT 1\`` and, on throw, returns
`{ status: 'down', error: err.message }`. The controller wraps a not-ready report in
`ServiceUnavailableException(report)`, so the full report (including `error`) is the 503 body:

```ts
// health.service.ts:43-53
catch (err) {
  return { status: 'down', error: err instanceof Error ? err.message : String(err) };
}
```

```ts
// health.controller.ts:50-57  (@Public(), @Get('ready'))
if (!report.ready) throw new ServiceUnavailableException(report);
```

The interface comment claims the field is "never the raw stack — kept terse for a probe", but
`err.message` from the pg adapter on a connection failure is not terse about the target: it carries
the connect address. Under the prod reverse proxy this route is reachable on the public origin —
Caddy's `@api` matcher (`path /api/*`) strips `/api` and forwards `/health/ready` to `api:3001`, and
the route is `@Public()`, so no Bearer JWT is required (unlike SEC-009's Swagger, `/health/*` is
deliberately public for orchestrators and is **not** stripped from the public origin).

The healthy path is fine (no `error` field). The leak only manifests during a DB outage — but that is
exactly when an attacker probing `/api/health/ready` learns the internal DB hostname/IP + port.

## Impact

Low, information-disclosure only. Anonymous, no auth needed; reveals internal network detail
(DB host/IP, port `5432`, sometimes the driver/dialect) precisely during a dependency outage. It does
not grant access. Mitigating: only non-empty during a failure; the value disclosed is topology, not
data or credentials. Aggravating: the surface is genuinely unauthenticated and public-origin-reachable
(health probes are intentionally `@Public`), so it is the one anonymous endpoint that can leak internal
infrastructure shape.

## Proof of concept

Reasoned from the code, **not executed** (the API/DB are not run during review). With the DB down,
behind Caddy:

```sh
curl -sk https://<site>/api/health/ready | jq '.checks.database.error'
# e.g. "\nInvalid `prisma.$queryRaw()` invocation:\nCan't reach database server at `db:5432`"
# or   "connect ECONNREFUSED 172.18.0.2:5432"
```

Directly against the API (dev): `curl -s localhost:3001/health/ready` after stopping Postgres.

## Affected

- `apps/api/src/health/health.service.ts:43-53` — `checkDatabase()` returns `err.message` verbatim.
- `apps/api/src/health/health.controller.ts:50-57` — `@Public()` route returns the report in the 503 body.
- `infra/caddy/Caddyfile:100-107` — `@api` forwards `/api/health/*` to the API on the public origin.

## Recommendation

Keep the readiness *signal* public but make the *detail* non-revealing:

1. Do not return the driver message to clients. Replace `error: err.message` with a fixed, generic
   string (e.g. `error: 'unreachable'`) — the boolean `ready` + `status: 'down'` already drives
   orchestrators; operators get the real cause from the correlated server log (the
   `AllExceptionsFilter`/Pino line, ADR-0031), not the public body.
2. If a human-readable cause is wanted, log `err` server-side (with the request id) and return only a
   coarse category (`'down'`).

Reference shape:

```ts
catch (err) {
  this.logger?.error({ err }, 'readiness DB check failed'); // server-side only
  return { status: 'down', error: 'unreachable' };          // generic for the public body
}
```

## Prevention

Make "a `@Public()` endpoint never echoes an exception/driver message to the client" a review rule —
the same principle the `PrismaExceptionFilter` already follows (its P2023/P2020 messages are
deliberately generic and "must not echo the offending column or value"). A unit test that asserts the
`down` body carries no host/port substring (and no raw `err.message`) locks it in.

## References

- CWE-209: Generation of Error Message Containing Sensitive Information.
- CWE-200: Exposure of Sensitive Information to an Unauthorized Actor.
- ADR-0031 (logging — server-side error capture) · ADR-0035 (fail-soft health) · SEC-009 (the other
  public/anonymous surface; the generic-error principle mirrors `PrismaExceptionFilter`).

## Resolution

**Status**: fixed
**Fixed in**: commit `6f75c92` (`fix: stop /health/ready leaking the raw DB driver error (SEC-070)`)
**Fixed by**: lazyit-remediator
**Date**: 2026-06-06

### Changes
- `apps/api/src/health/health.service.ts`: `checkDatabase()` no longer returns `err.message`. On a DB
  probe throw it logs the rich error server-side via the request-scoped `PinoLogger`
  (`logger.error({ err }, 'readiness DB check failed')`, correlated by request id per ADR-0031) and
  returns a fixed generic detail (`error: 'unreachable'`, the `DEPENDENCY_DOWN_DETAIL` constant). The
  503/`ready: false`/`status: 'error'` semantics are unchanged — orchestrators still pull the
  instance from rotation; only the public body detail is scrubbed.

### Tests added
- `apps/api/src/health/health.service.spec.ts`::`does not leak the raw driver message (host/IP/port)
  on a DB connection failure` — feeds a realistic `connect ECONNREFUSED 172.18.0.2:5432` rejection and
  asserts the returned detail contains none of the raw message, host/IP, port, or `ECONNREFUSED`.
  Fails without the fix (the old code echoed `err.message` verbatim), passes with it.
- `apps/api/src/health/health.service.spec.ts`::`logs the rich error server-side when the DB probe
  throws (ADR-0031)` — asserts the full error object is handed to the server logger (so operators keep
  the real cause off the public wire).
- Updated the existing "reports NOT ready" test to expect the generic `'unreachable'` detail.

### Verification
- `cd apps/api && bun test src/health/` → 8 pass / 0 fail (4 service + 4 controller).
- `cd apps/api && bunx tsc --noEmit -p tsconfig.json` → clean.

### Residual risk
None for this surface. The fix is scoped to the DB readiness check; any future dependency added to the
readiness report must follow the same pattern (generic client detail, rich detail server-side only).
