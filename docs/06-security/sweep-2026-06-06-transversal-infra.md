---
title: Sweep 2026-06-06 — transversal + infra trust boundary
tags: [security, sweep, transversal, infra]
status: draft
created: 2026-06-06
updated: 2026-06-06
---

# Sweep — 2026-06-06 — transversal / cross-cutting backend + infra

Offensive-security sweep of the cross-cutting backend surface and the listed modules:
`common`, `prisma`, `logging`, `dashboard`, `health`, the bootstrap (`main.ts`, `app.module.ts`,
`app.controller.ts`), and the infra/config trust boundary (`compose*.yaml`, `.dockerignore`,
`.env.example`, `infra/`). Method: `.claude/skills/lazyit-sentinel/SKILL.md`. Findings range
**SEC-070..SEC-079** (used SEC-070, SEC-071; range NOT exhausted).

## Scope

| Area | What was checked |
| --- | --- |
| Global validation pipe | Every `@Body()` is typed as a `createZodDto` (→ ZodValidationPipe validates it). Confirmed across all 13 controllers + config/service-accounts. |
| Exception filters | `AllExceptionsFilter` (single global) + `PrismaExceptionFilter` (P-code → 4xx). Info-leak / stack-to-client / unmapped-code 500s. |
| Decorators / actor | `@CurrentPrincipal`/`@CurrentUser`, `ActorService.resolveActor` (XOR userId/serviceAccountId, INV-SA-4). |
| Prisma | `PrismaService` proxy + soft-delete `$extends`, `withSoftDeleteFilter`, connection handling, raw SQL. |
| Logging | Pino config — PII/secret/body logging, redaction, request-id correlation. |
| Dashboard | `getSummary` + `getActivity` — info leak across soft-delete boundary, expensive queries / DoS, raw-SQL injection. |
| Health | `/health/live` + `/health/ready` (`@Public`) — info leak, unauthenticated surface. |
| Bootstrap | CORS origin, Swagger gate, trust proxy, body limits, global guard/pipe/filter wiring. |
| Infra | Caddy TLS/proxy + `trusted_proxies`, compose port bindings (`0.0.0.0` vs `127.0.0.1`), `:3001`/`:5432` exposure, `.dockerignore`, example secrets. |

## Findings

| ID | Sev | Module | One-line |
| --- | --- | --- | --- |
| [[SEC-070-health-ready-db-error-leak\|SEC-070]] | 🟡 Low | health | `/health/ready` (`@Public`) returns the raw DB driver error (internal host/port) on a DB outage |
| [[SEC-071-dashboard-soft-delete-relation-bypass\|SEC-071]] | 🟡 Low | dashboard | Dashboard counts/history include rows tied to soft-deleted apps/assets (nested-relation soft-delete gap; comment claims otherwise) |

No Critical / High / Medium this sweep. **No Critical → no immediate escalation.**

## Verified-clean re-grep (cheap invariants — a regression here IS a finding)

| Invariant | Result |
| --- | --- |
| No raw `$queryRawUnsafe` / `$executeRawUnsafe` | ✅ clean — none anywhere. |
| Raw SQL is parameterized only | ✅ `dashboard.service.ts` uses `Prisma.sql` + `Prisma.join` (every filter value is a bind param, never concatenated); `$queryRaw\`SELECT 1\`` in `health.service.ts` is a constant. |
| No `child_process` / `exec` / `spawn` / `eval` / `new Function` | ✅ clean — none in `apps/api/src` or `packages/shared/src`. |
| No runtime `fs` writes | ✅ only `readFileSync` (bootstrap-file, zitadel-management SA key, article-import from buffer); no `writeFile`/`createWriteStream`/`diskStorage`/`appendFile`. Import still parses from buffer, never writes to disk (path-traversal stays clean). |
| No sensitive logging | ✅ Pino logs metadata only (method/url/status/latency/request-id/actor) — never bodies; redacts `authorization`, `cookie`, `x-user-id`. SA token cleartext never persisted/logged (INV-SA-1). |
| Every `@Body` validated | ✅ all `@Body() dto: *Dto` are `createZodDto(...)` → global `ZodValidationPipe` validates each. |
| Soft-delete top-level filtering consistent | ✅ extension injects `deletedAt: null` on `findFirst/findMany/count/aggregate/groupBy` for all 9 + ServiceAccount soft-deletable models. (Nested relations NOT filtered → SEC-071.) |
| No committed secrets / trivial example creds in infra | ✅ `.env.example` + `infra/env/.env.prod.example` use `change_me`/`CHANGE_ME` placeholders; `.dockerignore` excludes `**/.env` + `**/.env.*` so no env file enters any image. |

## Regression checks on closed findings

| Closed finding | Status this sweep |
| --- | --- |
| SEC-004 (unvalidated uuid → 500) | ✅ holds. `PrismaExceptionFilter` maps `P2023`→400 and `P2020`→400 with generic messages (no column/value echoed); edge guards (`ParseUUIDPipe`, `parseUuidQuery`) still present. |
| SEC-005 (Postgres on 0.0.0.0 + trivial creds) | ✅ holds. Dev `db`/`meili`/`zitadel` publish `127.0.0.1` only (`compose.override.yaml`); prod has no `ports:` on `db` — only Caddy publishes (`${LAZYIT_HTTP_PORT:-8080}:80` / `:443`). |
| SEC-009 (public Swagger) | ✅ holds. `main.ts` mounts Swagger only when `NODE_ENV !== 'production'`; Caddyfile has no `@apidocs` handle (public `/api/docs*` → `@api` strip → 404). |
| SEC-010 (XFF spoof on setup rate-limit) | ✅ holds. `main.ts` sets `trust proxy` from `parseTrustProxy(TRUST_PROXY)`; Caddy `servers { trusted_proxies static private_ranges }` present. |

## Posture / things confirmed correct (not findings)

- **CORS** — single explicit origin from `WEB_ORIGIN` (default `http://localhost:3000`), never `*`,
  `credentials: true`, exposes `X-Request-Id`. Correct for the header-based shim (no cookie → classic
  CSRF n/a yet, per the SKILL).
- **PrismaExceptionFilter messages** — P2023/P2020/P2003/P2025 are generic (no column/value); P2002
  echoes only the constraint *field name(s)* (e.g. "email"), unchanged since baseline and intentional
  UX. Unmapped codes → `super.catch` → Nest generic 500 (no stack to client).
- **AllExceptionsFilter** — logs `{ err }` + stack server-side for ≥500 only; never sends the stack to
  the client. Request id rides every line (ADR-0031).
- **Health `/live`** — static `{ status: 'ok' }`, no leak. `app.controller.ts` `/` is NOT `@Public`, so
  it requires a token (no anonymous surface added).
- **Dashboard `getActivity`** — reads the `recent_activity` view (drops soft-deleted parents), fully
  parameterized, offset-paginated (ADR-0030), `q` ≤200 chars, `actorId="me"` resolved server-side
  (never trusts a client actor). The COUNT shares the WHERE/JOIN so `total` can't drift. Clean.

## Integration risks (non-security; flagged for the feature/DevOps lanes)

- **CORS allow-list is missing `PUT`.** `main.ts` `enableCors({ methods: ['GET','POST','PATCH','DELETE','OPTIONS'] })`
  omits `PUT`, but `config.controller.ts` exposes `@Put('permissions')` (the ADMIN role-permission
  editor, INV-8). A browser cross-origin preflight for that `PUT` will be rejected, so the permissions
  editor is unreachable from the web app. This is **fail-closed** (a functional break, not a
  vulnerability) — not filed as a SEC, but the methods list should include `PUT` (or the route move to
  `PATCH`). Owner: feature/web lane.
- **Dashboard `getSummary` cost.** ~11 concurrent queries; the `lowStock` read pulls every consumable
  with a `minStock` set (two int columns) and compares in-process — fine at small scale, grows with the
  consumable count. `getActivity` re-scans the full `recent_activity` UNION view (+ a COUNT) per call
  with a leading-wildcard `ILIKE`; gated on `logs:read` (ADMIN/MEMBER) so not anonymous, but worth an
  index/scale review as history grows. Same class as the open SEC-007 (pagination) — not re-filed.

## Coverage / gaps

- **Covered:** the full transversal surface above end-to-end, both dashboard endpoints, both health
  probes, the Pino config, the Prisma soft-delete extension logic, the exception-filter chain, CORS +
  trust-proxy + Swagger-gate wiring, and the infra trust boundary (compose, Caddy, dockerignore, env).
- **Reasoned, not executed:** the API/DB were not run (engagement rule); the `/health/ready` leak
  (SEC-070) and the soft-delete nested-relation behavior (SEC-071) were derived from code + ADR-0032's
  own "nested relations not filtered" clause, not a live request.
- **Out of scope / noted:** feature-module relation-include exposure (e.g. `assets.service.ts` includes
  soft-deletable `model`/`location`/`user`) is the higher-impact sibling of SEC-071 but lives in the
  assets lane and is the ADR-0032 deferred item — flagged in SEC-071 Prevention for the feature owner.
  Frontend, dependency CVEs, and `mammoth` internals remain out of scope.
