---
title: "ADR-0031: Structured logging strategy (Pino + nestjs-pino)"
tags: [adr]
status: accepted
created: 2026-05-26
updated: 2026-05-26
deciders: [Joaquín Minatel]
---

# ADR-0031: Structured logging strategy (Pino + nestjs-pino)

## Status

accepted — 2026-05-26. First front of the backend-completion epic (#4, sub-issue #5). Cross-cutting
infra; **no domain logic touched**. Uses the `X-User-Id` shim ([[0022-draft-visibility-auth-shim]])
for the actor field and coexists with the Prisma → HTTP mapping introduced alongside
[[0018-api-documentation-swagger]].

## Context

The API had no structured logging: nothing correlated the log lines of a single request, errors
(especially 500s) were only whatever Nest printed by default, and output was not adapted to the
environment. We want request/response logging with a propagated request id, all errors captured
(500s with their stack), output that is human-readable in dev and machine-readable (JSON) in prod,
and a small fixed log-category vocabulary the team reads at a glance.

## Considered options

**(1) Library — `winston` vs `pino` + `nestjs-pino`:** Pino is the fastest Node logger, JSON-first,
with first-class NestJS integration that binds a per-request child logger via `AsyncLocalStorage`
(request id on every line, no manual plumbing). → **pino + nestjs-pino**.

**(2) Category vocabulary — custom Pino levels vs standard levels + a documented mapping:** renaming
levels (`customLevels` + `useOnlyCustomLevels`) fights nestjs-pino / pino-http internals, which emit
at `info`/`warn`/`error`. → keep the **standard levels** as the mechanism and treat the four
categories as the **reading vocabulary**: `trace`/`debug` → **DEBUG**, `info` → **INFO**, `warn` →
**WARNING**, `error`/`fatal` → **CRITICAL**.

**(3) Request body logging — bodies vs metadata only:** this is a pre-auth app handling user PII, and
bodies can carry PII (and later credentials). → **metadata only** (method, url, status, latency,
request id, actor); bodies are not logged. Can be added later behind an explicit flag.

**(4) Error logging — a second competing global filter vs one catch-all that delegates:** two global
exception filters have fragile, order-dependent precedence. → a **single** `AllExceptionsFilter` is
the only global filter; it logs faults and **delegates** response mapping to the injected
`PrismaExceptionFilter` (Prisma errors) and to Nest's `BaseExceptionFilter` (everything else). No
ordering ambiguity, no change to the Prisma mapping.

## Decision

- **`pino` + `nestjs-pino`** (`pino-http` under the hood); **`pino-pretty` as a dev-only** transport.
- **Wiring:** `LoggerModule.forRoot(buildLoggerParams())` in `AppModule`;
  `NestFactory.create(AppModule, { bufferLogs: true })` + `app.useLogger(app.get(Logger))` in
  `main.ts`, so Nest's own logs flow through Pino too. The config is a single pure factory
  `buildLoggerParams(nodeEnv)` (`apps/api/src/logging/logging.config.ts`), unit-tested in isolation.
- **Request id:** `genReqId` honors an inbound `X-Request-Id` (else generates a `uuid`) and **echoes
  it on the response** `X-Request-Id` header; nestjs-pino then stamps it on every log line of the
  request. CORS **exposes** that header (`exposedHeaders: ['X-Request-Id']` in `main.ts`) so the
  browser can read it cross-origin — the web client captures it onto `ApiError.requestId` and shows
  it in its error UX ([[0020-frontend-data-layer]]).
- **Actor:** `customProps` surfaces the `X-User-Id` shim value as a clean `actor` field (null when
  absent); the raw `x-user-id` header is **redacted** from the logged headers.
- **Redaction:** `req.headers.authorization`, `req.headers.cookie`, `req.headers["x-user-id"]`.
- **Levels:** `debug` outside production, `info` in production. `customLogLevel` maps responses to
  the vocabulary: status ≥ 500 or error → `error` (CRITICAL), ≥ 400 → `warn` (WARNING), else `info`.
- **Format by environment:** `NODE_ENV === 'production'` → JSON (no transport); otherwise the
  `pino-pretty` transport. The prod container sets `NODE_ENV=production` ([[0028-secrets-and-config]]);
  local dev leaves it unset → pretty.
- **Errors:** a single global `AllExceptionsFilter` (`apps/api/src/common/all-exceptions.filter.ts`)
  logs every fault resolving to **HTTP ≥ 500** at `error` level with the exception/stack, then
  delegates: Prisma known errors → the injected `PrismaExceptionFilter` (P-code → 4xx preserved),
  everything else → `super.catch`. 4xx are left to autoLogging (`warn`) to avoid duplicate noise.

## Consequences

- **Positive:** every log line of a request shares a request id (client-supplied or generated, and
  echoed back for client-side correlation); 500s are captured with stacks; no PII/bodies in logs;
  output fits the environment; the four-category vocabulary is consistent and documented.
- **Operational:** prod **must** set `NODE_ENV=production` to emit JSON (handled by the prod compose,
  [[0028-secrets-and-config]] / DevOps lane). `pino-pretty` stays a dev dependency and is not used in
  prod, so it need not ship in the prod image.
- **Coexistence:** `PrismaExceptionFilter` is no longer a globally-registered filter; it is a plain
  provider injected into `AllExceptionsFilter`. Its behaviour is unchanged.

## Deferred (explicit)

- **Per-domain "important mutation event" logs** — the capability and pattern land here; the explicit
  `INFO` logs inside domain services arrive as later epic fronts (AssetHistory, Consumables) touch
  or create those services. This sub-issue deliberately does not touch domain code.
- **Request/response body logging** behind a flag; **log shipping / aggregation** (the prod stack
  only needs JSON on stdout for now); **tracing / OpenTelemetry**.

Related: [[0022-draft-visibility-auth-shim]] · [[0018-api-documentation-swagger]] ·
[[0028-secrets-and-config]] · [[code-conventions]] · [[claude-workflow]]
