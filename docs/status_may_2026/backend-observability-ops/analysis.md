# Backend observability & operational readiness — analysis

*as of 2026-05-30 (status_may_2026)*

## Role & scope

Senior Reliability Engineer pass over the lazyit **API** (`apps/api`), read-only. The mandate
is operational readiness for an **IT-generalist operator** (edits `.env`, runs
`docker compose up`, reads logs): health/readiness/liveness probes, graceful shutdown,
structured-log quality and actionability, correlation via `X-Request-Id`, startup validation of
env/config (fail-loud), DB connection error handling, and the self-hosted diagnostics surface —
all **without telemetry/phone-home**, and preserving the one-command-setup mandate. Findings are
ordered by priority. FACT = verified in code I read; PROPOSAL/OPINION is labelled.

## Method

Read, in full: `apps/api/src/main.ts`, `app.module.ts`, `app.controller.ts`, `app.service.ts`;
the logging layer `logging/logging.config.ts` (+ spec); the exception layer
`common/all-exceptions.filter.ts`, `common/prisma-exception.filter.ts` (+ specs);
`common/actor.service.ts`; `prisma/prisma.service.ts`, `prisma/prisma.module.ts`;
`search/search.service.ts`; `auth/auth.module.ts`, `auth/jwt-auth.guard.ts`;
`articles/article-import.ts` (env-driven config). Grepped every `process.env` use and every
logger call in `src`. Read the deployment surface: `infra/docker-compose.prod.yml`,
`infra/docker/api.Dockerfile`, `infra/docker/migrate.Dockerfile`, `infra/env/.env.prod.example`.
Read ADR-0031 (logging), ADR-0028 (secrets/config) and the runbooks
`docker-build-troubleshooting.md`, `deploy-self-hosted.md`. Cross-checked against the package
dependency list (no `@nestjs/terminus`, no config-validation lib present).

---

## Findings

### 1. No readiness probe — the only health signal is process-liveness, and it never checks the DB or Meili

- **Category:** infra · **Severity:** high · **Effort:** small · **Confidence:** high
- **Location:** `apps/api/src/app.controller.ts:8-11`; `infra/docker/api.Dockerfile:58-61`;
  `infra/docker-compose.prod.yml:46-59`
- **Observation (FACT):** The only endpoint the container exercises for health is `GET /`, which
  returns the literal string `"Hello World!"` (`AppController.getHello`). The Docker `HEALTHCHECK`
  hits `GET /` and treats `statusCode < 500` as healthy
  (`api.Dockerfile:60-61`). Because the global `JwtAuthGuard` runs on every route and there is no
  `@Public` decorator anywhere in `src` (grep returned nothing), in OIDC mode `GET /` returns
  **401** — and the healthcheck deliberately treats that as "alive" (comment at
  `api.Dockerfile:58-59`). This is a pure **liveness** check: the Node event loop is responding.
  It does **not** verify that Prisma can reach Postgres or that Meili is reachable. There is no
  `/health`, `/healthz`, `/ready`, or `/live` route (grep confirmed none). `@nestjs/terminus` is
  not a dependency (verified in `apps/api/package.json`).
- **Why it matters:** The product targets an IT generalist who "runs `docker compose up`" and
  needs **loud, actionable** signals. The compose file orders startup with `depends_on` +
  `service_healthy` for `db`, `zitadel_db`, `zitadel`, `meilisearch` — but the **API itself has no
  `healthcheck:` block** (`docker-compose.prod.yml:46-59`), so Caddy's `depends_on: api:
  condition: service_started` (line 189-190) waits only for the *container to start*, not for the
  API to be *ready to serve*. If Prisma's pool can't reach Postgres at runtime (DB restart, network
  blip, exhausted connections), the container still looks "started" and Caddy routes traffic into
  it; the operator sees opaque 500s with no single place to ask "is the API healthy?". A real
  readiness probe is the canonical way an operator (or a future orchestrator/monitoring) answers
  that question without phone-home.
- **Recommendation (PROPOSAL):** Add a tiny health module with two routes, both marked public
  (see finding #4 for the `@Public` decorator dependency):
  - `GET /health/live` → 200 always (process up). Point the Dockerfile `HEALTHCHECK` at it instead
    of `GET /` so the probe is explicit and not coincidentally-passing-via-401.
  - `GET /health/ready` → runs `SELECT 1` via `prisma.$queryRaw` and (optionally) `SearchService`
    reachability, returning `{ db: 'up'|'down', search: 'up'|'down'|'disabled', status:
    'ok'|'degraded' }`. Meili is fail-soft (ADR-0035) so its being down is **degraded, not
    unready** — readiness should be driven by the DB only, with search surfaced as informational.
  This is small and dependency-free (can be hand-rolled), or use `@nestjs/terminus` which gives
  `PrismaHealthIndicator` + `HttpHealthIndicator` out of the box. Add an `api` `healthcheck:` to
  the compose pointing at `/health/ready` and switch Caddy's `depends_on` to `service_healthy`.

### 2. Zero startup validation of required env/config — failures are deferred, partial, and per-request instead of fail-loud at boot

- **Category:** infra · **Severity:** high · **Effort:** small · **Confidence:** high
- **Location:** `apps/api/src/main.ts:7-44`; `apps/api/src/prisma/prisma.service.ts:24-29`;
  `apps/api/src/auth/jwt-auth.guard.ts:99-104`; `apps/api/src/search/search.service.ts:56-66`
- **Observation (FACT):** There is **no central env validation**. Config is read ad-hoc with raw
  `process.env.X` scattered across the codebase (grep found 14 sites). The failure modes are
  inconsistent:
  - `DATABASE_URL` missing → `PrismaService` constructor throws `new Error('DATABASE_URL is not
    set')` (`prisma.service.ts:26-28`). This *does* fail boot, but with a bare `Error` (no
    structured log, no remediation hint) — the runbook has to explain it
    (`docker-build-troubleshooting.md:58-62`).
  - `OIDC_ISSUER` missing in OIDC mode → **not** caught at boot. The guard is lazy
    (`jwt-auth.guard.ts:45-46`), so the app starts "fine" and then **every authenticated request**
    throws `UnauthorizedException('OIDC_ISSUER is not configured on the server')`
    (`jwt-auth.guard.ts:99-104`). The operator sees a healthy-looking container that 401s
    everything — the worst kind of silent misconfiguration.
  - `AUTH_SECRET`, `WEB_ORIGIN`, the OIDC client vars: no validation; misconfig surfaces as runtime
    auth failures or CORS rejections far from the cause.
  - `MEILI_HOST` unset is *intended* (disabled mode, logged once — `search.service.ts:62-65`),
    which is the correct pattern, but it is the **only** config that announces itself.
- **Why it matters:** The product's stated mandate is "one-command setup; **loud actionable
  errors**; safe defaults." Deferred, per-request config failures are the opposite of loud: the
  operator gets a running container and intermittent 401/500s with no boot-time "you forgot
  `OIDC_ISSUER`" message. For a self-hosted tool whose operator is not the author, fail-loud at
  startup with a one-line "set X in your .env" is the single highest-leverage reliability
  improvement. ADR-0028 documents the *layout* of config but nothing *validates* it.
- **Recommendation (PROPOSAL):** Add a single zod-validated config schema (the repo already
  standardises on zod via nestjs-zod, so this is idiomatic and dependency-free) parsed **once in
  `bootstrap()` before `NestFactory.create`**, branching on `AUTH_MODE`: in OIDC mode require
  `OIDC_ISSUER` (+ recommend `OIDC_CLIENT_ID`); always require `DATABASE_URL`; validate
  `WEB_ORIGIN` is a URL; warn when `NODE_ENV !== 'production'` in a prod image. On failure, log a
  CRITICAL line listing every missing/invalid var **and exit non-zero** so the container restarts
  loudly rather than serving broken. Keep `MEILI_HOST`/`MAX_IMPORT_SIZE_MB` optional with their
  current defaults. This preserves one-command setup (valid `.env.prod.example` still boots) while
  making misconfiguration impossible to miss.

### 3. The structured-log `actor` field is dead in production — it still reads the retired `X-User-Id` header, so prod logs have `actor: null` on every line

- **Category:** code-quality · **Severity:** medium · **Effort:** small · **Confidence:** high
- **Location:** `apps/api/src/logging/logging.config.ts:11,25-29,66`; cross-ref
  `apps/api/src/auth/jwt-auth.guard.ts:90-143`; `apps/api/src/common/actor.service.ts:1-19`
- **Observation (FACT):** `resolveActor` reads `req.headers['x-user-id']` and surfaces it as the
  `actor` log field (`logging.config.ts:25-29`, wired via `customProps` at line 66). The comment
  still says "the X-User-Id auth shim (ADR-0022)". But the auth model moved to OIDC (ADR-0038): in
  production the guard resolves the user from a **Bearer JWT** and sets `request.user`
  (`jwt-auth.guard.ts:140-141`); there is **no `x-user-id` header** in OIDC mode. `ActorService`
  now reads `user?.id` from `request.user` (`actor.service.ts:16`), confirming the actor lives on
  `request.user`, not a header. Therefore `customProps` resolves `x-user-id` → `null` on **every
  request in prod**. The header is also still in the redaction list (`logging.config.ts:72`),
  which is harmless but equally stale.
- **Why it matters:** "Are errors actionable?" — a 500 or a suspicious mutation in the logs has
  **no actor attached** in production. For an IT tool holding sensitive Access data, the audit
  value of "who triggered this request" is exactly what an operator needs when investigating an
  incident, and it's silently absent. This is doc-drift that became a functional gap when auth
  flipped to OIDC; ADR-0031's "actor" promise (consequence bullet) is no longer met in prod.
- **Recommendation (PROPOSAL):** Resolve `actor` from `request.user?.id` (set by the guard) via
  pino-http's `customProps(req)` — `req.user` is populated by the time the response is logged.
  Optionally also surface the JWT `sub`/`externalId` for pre-provision traceability. Update the
  comment and ADR-0031's actor bullet to reflect OIDC. Keep the `authorization`/`cookie`/`x-user-id`
  redaction (defence-in-depth) but the actor *source* must change.

### 4. No `@Public` route decorator — health/readiness endpoints (and Swagger try-it-out) cannot be exposed cleanly past the global guard

- **Category:** infra · **Severity:** medium · **Effort:** quick-win · **Confidence:** high
- **Location:** `apps/api/src/auth/auth.module.ts:13-21`; `apps/api/src/auth/jwt-auth.guard.ts:54-64`;
  grep for `Public`/`SetMetadata`/`isPublic` across `src` → none
- **Observation (FACT):** `JwtAuthGuard` is registered as a global `APP_GUARD`
  (`auth.module.ts:16-17`) and `canActivate` has no allowlist/metadata check — it unconditionally
  runs shim or OIDC logic for **every** route (`jwt-auth.guard.ts:54-64`). There is no
  `@Public()`/`@SkipAuth()` decorator + `Reflector` check anywhere. Today this "works" only because
  the Docker healthcheck deliberately accepts the resulting 401 as alive (finding #1), and Swagger
  UI at `/api/docs` is served by `SwaggerModule.setup` (`main.ts:40`) outside the router guard for
  the static UI, but its try-it-out calls would 401.
- **Why it matters:** Any genuine readiness probe (finding #1), and any future unauthenticated
  operational endpoint, **must** bypass the global guard. Without a `@Public` mechanism, you either
  leave health behind auth (probes can't distinguish "DB down" from "not logged in") or hack the
  guard. This is a small prerequisite that unblocks the readiness work and is broadly useful.
- **Recommendation (PROPOSAL):** Add a `@Public()` decorator (`SetMetadata('isPublic', true)`) and
  a `Reflector.getAllAndOverride('isPublic', ...)` early-return in `JwtAuthGuard.canActivate`.
  Apply it to the health routes only. Quick win, ~20 lines incl. a guard spec case.

### 5. DB connection has no retry/backoff and no actionable startup log — a not-yet-ready or briefly-unavailable Postgres crashes or silently degrades the API

- **Category:** infra · **Severity:** medium · **Effort:** small · **Confidence:** medium
- **Location:** `apps/api/src/prisma/prisma.service.ts:58-64`; cross-ref
  `infra/docker-compose.prod.yml:54-58`
- **Observation (FACT):** `onModuleInit` calls `await this.$connect()` with no try/catch, no retry,
  no log (`prisma.service.ts:58-60`). In compose, the API does `depends_on: db: service_healthy` +
  `migrate: service_completed_successfully` (`docker-compose.prod.yml:54-58`), so first-boot
  ordering is handled. But: (a) `$connect()` failing at boot throws an unhandled bootstrap error
  with no structured, remediation-oriented log line (the operator gets a raw Nest stack); (b) there
  is **no resilience to a Postgres restart at runtime** — Prisma's pool will surface errors on the
  next query, which then become 500s, and the API has no readiness signal (finding #1) to drain
  traffic during the blip; (c) the `restart: unless-stopped` policy means a boot-time DB failure
  loops the container with the same opaque error.
- **Why it matters:** Self-hosted operators reboot hosts, take DB backups, and resize volumes —
  transient DB unavailability is normal, not exceptional. A boot that fails loudly-but-uselessly,
  with no log explaining "could not connect to DATABASE_URL host `db:5432` — is Postgres up?",
  forces the operator to dig through stacks. ADR-0028's `pg_isready` healthcheck on `db` mitigates
  *first boot* but not *runtime* blips.
- **Recommendation (PROPOSAL):** Wrap `$connect()` in a small bounded retry-with-backoff (e.g. 5
  attempts, capped) and emit a structured CRITICAL log on each failure including the *host* (parsed
  from `DATABASE_URL`, never the password) and a one-line hint. Pair with the readiness probe
  (#1) so runtime blips drain rather than 500. Keep it minimal — do not introduce a heavy
  resilience framework.

### 6. No graceful-shutdown handling for in-flight requests or the Meili fire-and-forget tail; only Prisma `$disconnect` is wired

- **Category:** infra · **Severity:** medium · **Effort:** small · **Confidence:** medium
- **Location:** `apps/api/src/main.ts:13`; `apps/api/src/prisma/prisma.service.ts:62-64`;
  `apps/api/src/search/search.service.ts:77-105`
- **Observation (FACT):** `app.enableShutdownHooks()` is set (`main.ts:13`), which fires
  `PrismaService.onModuleDestroy` → `$disconnect()` on SIGTERM/SIGINT
  (`prisma.service.ts:62-64`). That is the *only* shutdown handling. There is **no explicit
  draining of in-flight HTTP requests** beyond what Nest/Express does on `app.close()`, and the
  Meili `upsert`/`remove` calls are **fire-and-forget promises** (`search.service.ts:79-88`,
  `96-104`) that are deliberately un-awaited — on SIGTERM these can be dropped, leaving the search
  index transiently out of sync with the DB after a deploy/restart. There is no `SIGTERM` log line,
  so the operator can't tell a graceful stop from a crash in the logs.
- **Why it matters:** Compose `restart: unless-stopped` + redeploys mean SIGTERM is routine. Prisma
  disconnect is the most important piece and it's handled, so this is medium not high — but the
  missing in-flight drain can truncate a mutation's response mid-write (the DB commit may have
  landed; the client sees a dropped connection), and the dropped Meili tail is a known eventual
  drift the operator can only fix by re-running `reindex:all`
  (`docker-compose.prod.yml:160-161`). A "shutting down" log line is a cheap actionability win.
- **Recommendation (PROPOSAL):** Log a CRITICAL/INFO "received SIGTERM, draining" on the shutdown
  hook. Confirm `enableShutdownHooks` + Nest's `app.close()` actually awaits in-flight handlers
  (document the behaviour). For Meili drift, the pragmatic answer is to keep fire-and-forget
  (ADR-0035) but document that a restart may require `reindex:all`, or track a bounded set of
  in-flight index promises and `await Promise.allSettled` them on shutdown with a short timeout.

### 7. Domain code emits no operational logs — the only signals are 500s, Meili failures, and OIDC userinfo warnings; important mutations are invisible

- **Category:** infra · **Severity:** medium · **Effort:** medium · **Confidence:** high
- **Location:** grep of all logger calls in `src` (excluding specs) → only
  `common/all-exceptions.filter.ts:34` (`'Unhandled server error'`),
  `search/search.service.ts:62,83,99`, and `auth/jwt-auth.guard.ts:249,256,288,295` (userinfo
  warnings); ADR-0031 "Deferred" section confirms this was intentional
- **Observation (FACT):** Outside the cross-cutting filter, search service, and auth guard, **no
  domain service logs anything**. There are no INFO events for create/update/soft-delete of assets,
  access grants, consumable movements, etc. pino-http autoLogging records the request line
  (method/url/status/latency/request-id) for every request, but the *semantic* event ("access
  grant X revoked by user Y") is not logged. ADR-0031's "Deferred (explicit)" section openly
  records this: "Per-domain 'important mutation event' logs — the capability and pattern land here;
  the explicit INFO logs inside domain services arrive as later epic fronts."
- **Why it matters:** lazyit holds **Access** data (who can reach what) and an append-only audit
  story is a core product pillar (AssetHistory, AccessGrant, ConsumableMovement are append-only by
  design). But the *operational log stream* an admin reads (vs. the in-DB history) has no
  business-event visibility: when something goes wrong, the operator can correlate by request-id but
  can't grep the logs for "who revoked access to App Z last Tuesday" without querying the DB. For a
  ServiceNow-grade aspiration operated by IT, a thin, consistent "important mutation" INFO log
  (method/route already give the *what*; add actor + entity id + action) materially improves
  incident response. This is the natural pairing with finding #3 (actor) and #8 (audit surfacing).
- **Recommendation (PROPOSAL):** Establish a small convention — a lightweight interceptor or a
  shared `logMutation(action, entity, id, actorId)` helper — emitting one INFO line per
  state-changing operation (POST/PATCH/DELETE) with `{ action, entity, id, actor, requestId }` and
  **no bodies** (consistent with ADR-0031's metadata-only stance). Roll out incrementally per
  module, starting with the Access pillar (highest sensitivity). This is the deferred work
  ADR-0031 anticipated; sequence it after #3 so actor is correct.

### 8. No operator-facing diagnostics surface (version/build info, config summary, audit-log view) — and no `/health` to point a monitor at, without phone-home

- **Category:** feature · **Severity:** low · **Effort:** medium · **Confidence:** medium
- **Location:** `apps/api/src/app.controller.ts` (only `GET /` → "Hello World!");
  `docs/05-runbooks/deploy-self-hosted.md:55` (operator told to use `docker compose ps` only)
- **Observation (FACT):** The only operator-facing runtime affordance is `docker compose ps` /
  `docker compose logs` (deploy runbook line 55, troubleshooting runbook). There is **no
  build/version endpoint** (the API version is hardcoded `'0.1'` in the Swagger
  `DocumentBuilder` at `main.ts:36` and nowhere queryable at runtime), **no config-summary
  diagnostic** ("AUTH_MODE=oidc, MEILI=enabled, DB=connected"), and **no audit-log surfacing**
  endpoint (the gaps brief confirms "audit-log surfacing: none built"). Everything respects the
  no-phone-home rule (good — all signals are pull/local), but the *pull surface* is thin.
- **Why it matters:** The product wants to "grow into a large, easy-to-use platform operated mainly
  by IT." An IT generalist diagnosing a self-hosted box wants to ask the running API: what version
  am I on, is my config sane, is the DB/search up — locally, without external telemetry. Right now
  the answer is "read container logs and hope." This is the operability foundation the platform
  ambition needs, and it composes with #1 (`/health/ready`) and #7 (mutation logs).
- **Recommendation (PROPOSAL):** After the readiness work (#1), add a `/health/ready` payload that
  doubles as a diagnostic: `{ status, version, authMode, db, search }` (version injected from
  `package.json`/build arg, never secrets). Defer audit-log *surfacing* (an Access-pillar feature
  with authZ implications — see the RBAC gap) but record it as the next operability step. All local,
  no phone-home.

### 9. Sensitive identifiers risk leaking into logs via the `err`/stack on 500s; redaction covers headers only

- **Category:** security · **Severity:** low · **Effort:** small · **Confidence:** medium
- **Location:** `apps/api/src/common/all-exceptions.filter.ts:33-34`;
  `apps/api/src/logging/logging.config.ts:68-75`
- **Observation (FACT):** On any ≥500 fault the filter logs `{ err: exception }` with the full
  exception and stack (`all-exceptions.filter.ts:34`). Pino redaction (`logging.config.ts:69-74`)
  covers `req.headers.authorization`, `req.headers.cookie`, `req.headers["x-user-id"]` — i.e.
  **request headers only**. It does not redact anything inside the serialized error object. A
  Prisma error that reaches the 500 path (an *unknown* code, since known codes are mapped to 4xx by
  `PrismaExceptionFilter`) can carry `meta`/`message` fields; the `PrismaExceptionFilter` already
  notes (line 48-52) that messages "must not echo the offending column or value" for the *HTTP
  response*, but the *logged* `err` has no such scrubbing.
- **Why it matters:** ADR-0031 chose metadata-only logging precisely because this is a PII-handling
  app. Stacks and error `meta` on 500s are a smaller, but real, leak channel into the log stream
  (which an operator may ship or share when asking for help). Low severity because 500s should be
  rare and known Prisma codes are pre-mapped, but worth noting in the same lane as SEC findings.
- **Recommendation (PROPOSAL):** Keep logging the stack (it's needed) but consider pino
  `serializers.err` to drop/limit `meta` on Prisma errors, and document that operators should treat
  500-stack logs as potentially sensitive when sharing. Coordinate with the Sentinel lane rather
  than acting unilaterally.

### 10. `pino-pretty` selection is keyed only on `NODE_ENV` — a prod image missing `NODE_ENV=production` silently logs pretty (unparseable) text and would reference a non-shipped devDependency

- **Category:** infra · **Severity:** low · **Effort:** quick-win · **Confidence:** high
- **Location:** `apps/api/src/logging/logging.config.ts:51-64`; cross-ref `api.Dockerfile:42`
  (`ENV NODE_ENV=production`) and ADR-0031 "Operational" bullet
- **Observation (FACT):** `buildLoggerParams` switches on `nodeEnv === 'production'`
  (`logging.config.ts:51`): prod → JSON (no transport), else → `pino-pretty`. The API Dockerfile
  hard-sets `ENV NODE_ENV=production` (`api.Dockerfile:42`) and compose doesn't override it, so the
  prod path is correct **today**. The fragility: if an operator runs the API outside that image
  (bare `node dist/...`, or a future compose that overrides env) without `NODE_ENV=production`, they
  silently get pretty-printed logs — which (a) pull `pino-pretty` (a *devDependency* not shipped in
  the prod image per ADR-0031) and would crash, or (b) emit non-JSON that breaks any log
  aggregation. ADR-0031 already flags "prod **must** set `NODE_ENV=production`" as an operational
  caveat, so this is a known-but-unguarded contract.
- **Why it matters:** It's a quiet foot-gun for the self-hosted operator who deviates from the
  golden path. Tie it to the env-validation finding (#2): a boot-time warn "NODE_ENV is not
  'production' in a production deployment" closes the gap cheaply.
- **Recommendation (PROPOSAL):** In the config validation (#2), warn loudly when the prod image
  boots without `NODE_ENV=production`. Optionally allow an explicit `LOG_FORMAT=json|pretty`
  override so format isn't *only* coupled to `NODE_ENV`.

---

## Quick wins (under ~2 hours each)

1. **Add a `@Public()` decorator + `Reflector` check in `JwtAuthGuard`** (finding #4) — ~20 lines +
   a spec case; unblocks every other health/diagnostic improvement.
2. **Fix the dead `actor` log field** (finding #3) — resolve from `req.user?.id` instead of the
   retired `x-user-id` header; update the comment and ADR-0031's actor bullet. Restores
   actor-in-logs in production.
3. **Add a `SIGTERM` "draining" log line** on the shutdown hook (finding #6) — lets the operator
   distinguish a graceful stop from a crash in the log stream.
4. **Boot-time `NODE_ENV` warning** (finding #10) — one-line guard that prevents silent pretty-log
   misconfiguration outside the golden-path image.
5. **Wrap `$connect()` with a structured CRITICAL log** (subset of #5) — even without retry, a
   single "could not connect to DATABASE_URL host <host>; is Postgres up?" log turns an opaque
   bootstrap stack into an actionable message.

## Strategic recommendations (bigger bets, with sequencing)

1. **Operability foundation (sequence first).** `@Public` decorator (#4) → health module with
   `/health/live` + `/health/ready` (#1) → wire compose `api healthcheck` + Caddy
   `service_healthy` → repoint the Dockerfile `HEALTHCHECK` at `/health/live`. This is the
   single most valuable cluster for a self-hosted IT operator and is dependency-free (or
   `@nestjs/terminus`, which would be a small new ADR). It also delivers the diagnostic payload
   of #8.
2. **Fail-loud config (sequence early, parallel to #1).** Central zod-validated config parsed in
   `bootstrap()` before `NestFactory.create`, branching on `AUTH_MODE` (#2 + #10). Converts the
   worst silent failure (missing `OIDC_ISSUER` → every request 401s) into a loud boot error.
   Depends on nothing; pairs with the `NODE_ENV` warning.
3. **DB resilience + graceful drain (after #1).** Bounded `$connect` retry + structured logs (#5)
   and SIGTERM draining + Meili-tail handling (#6), with the readiness probe (#1) as the
   traffic-draining signal. Depends on the health endpoints existing.
4. **Operational log story (after #3 actor fix).** A thin, metadata-only "important mutation" INFO
   convention rolled out per module, starting with the Access pillar (#7), then an operator-facing
   audit-log surfacing feature (#8) — the latter has authZ implications and intersects the known
   RBAC gap, so it needs product input.

## Open questions for the CTO/CEO

1. **`@nestjs/terminus` or hand-rolled health?** Terminus gives `PrismaHealthIndicator` +
   readiness/liveness conventions for free but adds a dependency and would warrant a short ADR. A
   hand-rolled `/health/ready` (a `$queryRaw('SELECT 1')` + a Meili ping) keeps the dependency
   surface minimal, consistent with the "boring, durable, self-hosted" philosophy. Which do you
   prefer?
2. **Readiness semantics for Meili.** Should Meili being down make the API "unready" (drains
   traffic) or merely "degraded" (still serves; search returns empty per ADR-0035 fail-soft)? I lean
   **degraded** to honour ADR-0035, but confirm — it affects what the compose healthcheck gates.
3. **Config validation strictness.** Should a missing *recommended-but-optional* var (e.g.
   `OIDC_CLIENT_ID` for audience validation) be a hard boot failure or a loud warning? Hard-fail is
   safer for an Access-data tool; warn preserves the easiest first-boot. Your call sets the
   fail-loud line.
4. **Mutation-event logging scope.** ADR-0031 deferred per-domain INFO logs. Do you want this now
   (improves incident response, no phone-home) as a cross-cutting interceptor, and is metadata-only
   (action/entity/id/actor, no bodies) the right privacy line — or should it wait for the audit-log
   *feature* so we build it once?
5. **Is operator-facing audit-log surfacing (#8) a near-term goal?** It's an Access-pillar feature
   that intersects the missing RBAC model (who may read the audit log). It can't be scoped safely
   without the authorization decision.
