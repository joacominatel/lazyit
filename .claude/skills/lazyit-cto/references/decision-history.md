# Decision History

> This document is a **CTO-friendly index of major decisions** taken across the project — ADRs and broader strategic calls. It exists to let the CTO quickly check "is this already decided?" without reading thirty ADR files.
>
> **Owner**: CTO. Updated when a new ADR is accepted, or when a non-ADR strategic decision lands in a session.
>
> Initially populated: 2026-05-26 (first CTO session), from all 36 ADRs in `docs/03-decisions/`.

---

## How to use this file

When designing a plan or considering an escalation, the CTO scans this file for:
- Decisions that constrain the task (must follow X)
- Decisions that have been superseded (don't follow Y; we changed our mind)
- Decisions deferred (don't try to settle Z; it's parked deliberately)

---

## Index of major decisions

### Architecture

**ADR-0001** — *Monorepo with Bun workspaces + Turborepo*
**Status**: accepted
**One-liner**: single repo; Bun workspaces for packages; Turborepo for build orchestration.
**CTO note**: tooling is Bun; don't introduce npm/yarn/pnpm/npx.

---

**ADR-0002** — *NestJS for the backend*
**Status**: accepted
**One-liner**: NestJS (Express) for the API; opinionated structure, mature, domain-friendly.
**CTO note**: backend agents work within NestJS module conventions; no raw Express handlers.

---

**ADR-0003** — *Prisma as ORM on PostgreSQL*
**Status**: accepted
**One-liner**: Prisma schema-first ORM; `@prisma/adapter-pg`; `moduleFormat = "cjs"` for NestJS.
**CTO note**: schema changes require `bunx prisma migrate dev`; generated client at `apps/api/generated/prisma`.

---

**ADR-0009** — *Bun-first guidance vs the chosen app stack*
**Status**: accepted
**One-liner**: Bun for tooling/scripts/shared package; NestJS + Prisma + Jest for the app layer.
**CTO note**: never replace NestJS with `Bun.serve`, Prisma with `Bun.sql`, or Jest with `bun test` in `apps/api`.

---

**ADR-0010** — *Next.js for the frontend*
**Status**: accepted
**One-liner**: Next.js App Router + React; server components where they help.
**CTO note**: App Router; no Pages Router patterns.

---

**ADR-0011** — *Tailwind CSS + shadcn/ui for styling*
**Status**: accepted
**One-liner**: Tailwind v4 + shadcn/ui (`radix-nova`, `neutral` base); heroicons in app code, lucide only inside `components/ui/*`.
**CTO note**: enforce heroicons rule; lucide-react must not leak into app code.

---

**ADR-0014** — *Build @lazyit/shared to CommonJS + declarations*
**Status**: accepted
**One-liner**: shared package emits CJS + `.d.ts` so NestJS (CJS) and Next.js can consume it.
**CTO note**: `@lazyit/shared` must be built before typecheck/test in CI; never import its source directly.

---

**ADR-0018** — *API documentation with Swagger/OpenAPI (nestjs-zod)*
**Status**: accepted (supersedes ADR-0013)
**One-liner**: Swagger UI at `/api/docs`; `nestjs-zod` + `createZodDto` for type-safe DTOs and validation.
**CTO note**: ADR-0013 (custom ZodValidationPipe) is superseded. All endpoints use `createZodDto`; global `ZodValidationPipe`.

---

**ADR-0020** — *Frontend data layer (endpoints → hooks → components)*
**Status**: accepted
**One-liner**: `lib/api/endpoints/*.ts` → `lib/api/hooks/*.ts` → pages/components. Never call endpoints directly from components.
**CTO note**: validated on 4+ screens. `crud-endpoints.ts` factory for standard CRUD; `query-keys.ts` factory per entity.

---

**ADR-0025** — *Containerization & image strategy (Bun build → Node runtime)*
**Status**: accepted
**One-liner**: Multi-stage Docker images; Bun for build, Node for runtime in prod.
**CTO note**: three Dockerfiles in `infra/docker/`. DevOps owns Dockerfile changes.

---

**ADR-0026** — *Reverse proxy & TLS (Caddy), same-origin `/api` routing*
**Status**: accepted
**One-liner**: Caddy as the only public-facing service; `/api` proxied to API, `/` to web.
**CTO note**: `NEXT_PUBLIC_API_URL=/api` baked at build time — relative path, domain-portable (ADR-0026).

---

**ADR-0027** — *CI on GitHub Actions; CD deferred*
**Status**: accepted
**One-liner**: CI: typecheck, lint (non-blocking), tests, build, docker images. No CD yet.
**CTO note**: lint is `continue-on-error: true` until codebase is lint-clean. CD ADR pending.

---

**ADR-0028** — *Secrets & configuration management (env files per level)*
**Status**: accepted
**One-liner**: one `.env` per scope (root for Postgres, `apps/api/.env`, `infra/env/.env.prod`); committed `.env.example` only.
**CTO note**: no secrets in code; always add to `.env.example` first.

---

**ADR-0035** — *Cross-cutting search architecture (Meilisearch)*
**Status**: accepted
**One-liner**: Meilisearch for unified cross-entity search; service-layer sync (fire-and-forget); fail-soft.
**CTO note**: Meilisearch now in both dev and prod compose (PR #38). `GET /search?q=&entities=&limit=20`.

---

**ADR-0037** — *IdP choice (Zitadel) + BYOI pattern*
**Status**: accepted (2026-05-27)
**One-liner**: Zitadel as bundled default OIDC IdP; its own Postgres; BYOI via 3 env vars (OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET).
**CTO note**: backend speaks generic OIDC — zero Zitadel-specific code. Caddy routes `auth.{LAZYIT_DOMAIN}` → Zitadel. Bootstrap runbook at `docs/05-runbooks/auth-bootstrap.md`. CEO decisions: own Postgres for Zitadel (clean removal path), BYOI is load-bearing (3 env vars = full swap).

---

**ADR-0038** — *JIT user provisioning on first OIDC login*
**Status**: accepted (2026-05-27)
**One-liner**: auto-provision User from OIDC claims on first login; assumes trusted IdP; no pre-registration in lazyit needed.
**CTO note**: CEO chose Option 1 (auto-provision). Claims mapping: sub→externalId, email, given_name+family_name→firstName/lastName. Future opt-in: `USER_PROVISIONING_MODE=manual` for stricter control. Guard uses `jose`, no Passport. `AUTH_MODE=shim` retained for dev/tests.

---

### Domain

**ADR-0004** — *Asset-centric domain design*
**Status**: accepted
**One-liner**: Asset is the first-class citizen; ownership is a timestamped join (AssetAssignment), not a column.
**CTO note**: pushing back against user-centric features is the CTO's job.

---

**ADR-0005** — *Mixed ID strategy (uuid / cuid / autoincrement)*
**Status**: accepted
**One-liner**: `User.id` = uuid (sensitive/exposed); domain entities = cuid; logs/history = autoincrement.
**CTO note**: new entities default to cuid unless they need uuid (user-facing exposure) or autoincrement (log tables, never exposed).

---

**ADR-0006** — *Soft delete & append-only auditing*
**Status**: accepted
**One-liner**: mutable entities have `deletedAt`; append-only tables (AssetAssignment, AssetHistory, AccessGrant, ConsumableMovement) never soft-delete.
**CTO note**: append-only tables use `releasedAt`/`revokedAt` lifecycle markers instead.

---

**ADR-0007** — *Flexible asset specs via jsonb*
**Status**: accepted
**One-liner**: `Asset.specs`, `AssetModel.specs`, `Article.metadata` are `Json?` (jsonb); app-level validation via zod.
**CTO note**: `specs` fields are intentional flexibility debt — validated by the frontend as loose schemas. Don't tighten the Prisma type.

---

**ADR-0008** — *Consumables modeled separately from assets*
**Status**: accepted
**One-liner**: Consumable (stock-counted) vs Asset (individually tracked) are distinct entities.
**CTO note**: cables, toner, adapters = Consumable; laptops, servers = Asset. Don't conflate.

---

**ADR-0012** — *Testing strategy*
**Status**: accepted
**One-liner**: unit tests always; core/complex logic thoroughly. No global coverage gate. E2E deferred.
**CTO note**: Jest for `apps/api`; `bun test` for `packages/shared`. E2E choice deferred (no critical flows yet).

---

**ADR-0017** — *Location type as a hardcoded enum*
**Status**: accepted
**One-liner**: `LocationType` is a Postgres enum (OFFICE, DATACENTER, RACK, REMOTE, STORAGE, OTHER); user-managed types deferred.
**CTO note**: don't add user-managed location types without a new ADR.

---

**ADR-0019** — *AssetAssignment referential integrity & lifecycle*
**Status**: accepted (actor source superseded by ADR-0024)
**One-liner**: assignment FKs use Restrict (history preserved); partial unique index `(assetId, userId) WHERE releasedAt IS NULL` in raw SQL migration.
**CTO note**: the actor source was superseded by ADR-0024; the lifecycle/integrity rules remain.

---

**ADR-0021** — *Knowledge Base design — simple wiki*
**Status**: accepted
**One-liner**: Article + ArticleCategory; markdown body; DRAFT/PUBLISHED status; `.docx` import via mammoth.
**CTO note**: article versioning deferred. ArticleVersion model exists in schema but not wired.

---

**ADR-0033** — *AssetHistory event model (discrete events, explicit emission)*
**Status**: accepted
**One-liner**: explicit service calls emit AssetHistory events transactionally (not an interceptor).
**CTO note**: event types: CREATED, STATUS_CHANGED, ASSIGNED, RELEASED, LOCATION_CHANGED, MODEL_CHANGED, SPECS_CHANGED, DELETED, RESTORED. RESTORED not yet emitted.

---

**ADR-0034** — *Consumables design (cached stock + append-only movements)*
**Status**: accepted
**One-liner**: `Consumable.currentStock` is a cached int updated transactionally by ConsumableMovement. Never edited directly.
**CTO note**: movement types: IN, OUT (409 if stock goes negative), ADJUSTMENT (absolute recount).

---

**ADR-0036** — *Integer fields bounded to the Postgres int4 range in shared schemas*
**Status**: accepted
**One-liner**: all `Int` fields in shared zod schemas are bounded with `z.number().int().min(0).max(2_147_483_647)` to prevent int4 overflow (P2020 → 500).
**CTO note**: raised by bug where Swagger UI sent `Number.MAX_SAFE_INTEGER`, causing P2020. New int fields must follow this pattern.

---

### Identity & access

**ADR-0015** — *Deployment model — self-hosted for IT teams*
**Status**: accepted
**One-liner**: Docker Compose as the deployment unit; single-org; customer's infrastructure; no cloud dependency.
**CTO note**: any feature requiring a managed cloud service violates this. Even the IdP must be self-hostable.

---

**ADR-0016** — *Authentication deferred; external IdP when needed*
**Status**: accepted → **superseded in practice by ADR-0037 + ADR-0038** (2026-05-27)
**One-liner**: no auth yet; endpoints are unauthenticated; future auth = OIDC with self-hosted IdP; `User.externalId` reserved for `sub`.
**CTO note**: now resolved. Backend auth (Phase 2) complete. Phase 3 (frontend) pending.

---

**ADR-0022** — *Draft visibility & the X-User-Id auth shim*
**Status**: accepted → **superseded in the OIDC path by ADR-0038** (2026-05-27). Preserved as `AUTH_MODE=shim` for dev/tests.
**One-liner**: `X-User-Id` header simulates the caller; present+valid → actor, absent → anonymous, invalid → 400.
**CTO note**: shim is now the guard's `AUTH_MODE=shim` branch. Authorization rules (draft privacy, author-only writes) still use `@CurrentUser()` — same logic, different source.

---

**ADR-0023** — *Access management design (Application + AccessGrant)*
**Status**: accepted
**One-liner**: append-only AccessGrant per user+app; no uniqueness constraint (multi-grant allowed); revokedAt closes grant; actor from @CurrentUser().
**CTO note**: `GET /access-grants` is the most sensitive list endpoint (exposes all user↔app grants). First to paginate when SEC-007 is addressed.

---

**ADR-0024** — *Retrofit AssetAssignment actor to the X-User-Id shim*
**Status**: accepted → **superseded in the OIDC path by ADR-0038** (2026-05-27). Shim path preserved via `AUTH_MODE=shim`.
**One-liner**: removed `assignedById`/`releasedById` from request body; actor now comes from ActorService (resolved User from @CurrentUser()).
**CTO note**: body-supplied-actor divergence between AssetAssignment and AccessGrant is resolved. Both use ActorService (now trivial: `user?.id`).

---

### Cross-cutting concerns

**ADR-0029** — *Untrusted-content sanitization is render-time, not write-time*
**Status**: accepted
**One-liner**: store raw, sanitize at render time with allow-list (DOMPurify). Write-side only for clearly-dangerous structured values (e.g. URL schemes).
**CTO note**: the regex import sanitizer was removed (commit `8e34074`). SEC-003 stays open until DOMPurify lands in the web KB renderer.

---

**ADR-0030** — *List endpoint pagination contract (offset; implementation deferred)*
**Status**: accepted
**One-liner**: `PageQuery` + `Page<T>` in `@lazyit/shared`; default 50, max 200. Existing 11 `findAll`s not yet retrofitted.
**CTO note**: contract defined; implementation deferred. New list endpoints must use it. Prioritize `GET /access-grants` first when building. Spans front+back (two subagents).

---

**ADR-0031** — *Structured logging strategy (Pino + nestjs-pino)*
**Status**: accepted
**One-liner**: Pino + nestjs-pino; JSON in prod, pretty in dev; X-Request-Id per request; bodies NOT logged.
**CTO note**: `X-Request-Id` is exposed via CORS and surfaced in the frontend error UX.

---

**ADR-0032** — *Soft-delete enforcement via a Prisma client extension*
**Status**: accepted
**One-liner**: `$extends` on PrismaService automatically adds `deletedAt: null` to read queries.
**CTO note**: append-only tables are excluded. Services never need to remember to add `deletedAt: null`.

---

### Workflow & coordination

**ADR-0013** — *Custom ZodValidationPipe*
**Status**: superseded by ADR-0018
**CTO note**: ignore this ADR; ADR-0018 (nestjs-zod global pipe) is the current pattern.

---

## Decisions made outside ADRs

| Date | Decision | Context | Implication |
|------|----------|---------|-------------|
| 2026-05-25 | SEC-002 deferred to BullMQ async worker | .docx decompression bomb requires memory-budgeted worker | Must not build BullMQ without addressing SEC-002 in the same work |
| 2026-05-25 | SEC-003: store raw KB content, sanitize at render time (ADR-0029) | DOMPurify at the frontend KB renderer | Don't add a raw-HTML renderer without DOMPurify in the same change |
| 2026-05-25 | SEC-007: pagination contract defined (ADR-0030), implementation deferred to subagent split | MVP scale tolerable for now | Two subagents (back + front) when impl starts; GET /access-grants first |
| 2026-05-26 | Frontend completion epic (#20) fully closed | All 5 sub-issues merged | Frontend now matches backend capability |
| 2026-05-26 | **Zitadel chosen as bundled IdP** | Fits operator profile (IT generalist + Docker); lighter than Keycloak; simpler stack than Authentik | All auth epic design is Zitadel-first; BYOI must remain possible via env swap |
| 2026-05-26 | **Zitadel gets its own Postgres** (not shared with app DB) | Clean separation; Zitadel does aggressive migrations; independent backup; clean BYOI removal path | Two DB services in prod compose; DevOps owns the Zitadel DB service |
| 2026-05-26 | **BYOI is load-bearing** — backend must speak standard OIDC, not Zitadel-specific | Customer may bring Azure AD, Okta, Keycloak; swap IdP by editing .env only | Must be documented in auth ADR; no Zitadel SDK in app code |
| 2026-05-26 | **Bootstrap runbook for first admin** is Phase 1 deliverable | Operator won't know Zitadel console; DevOps must provide a clear runbook | No skipping this; a self-hosted product is unusable if the first user can't be created |
| 2026-05-26 | **Frontend auth library**: Auth.js v5 (NextAuth) with generic OIDC provider — CTO's call | BYOI-compatible (generic OIDC provider config); App Router native; HTTP-only cookie session | ADR-0039 to document the choice |
| 2026-05-26 | **X-User-Id shim retained** as `AUTH_MODE=shim` env var (dev/test only) | Existing Jest tests use it; rewriting adds no value; must be impossible to set in prod by default | Disabled in prod by default; guards must verify env before accepting shim |
| 2026-05-26 | **Phase 2+4 merged** — ActorService → @CurrentUser() is part of backend OIDC integration, not a cleanup phase | CEO's guidance: changing the actor source is integral to the integration, not a post-step | Backend agent delivers ActorService migration in the same phase as JWT validation |
| 2026-05-26 | **JIT user provisioning: auto-provision on first login (Option 1)** | For 5–20 users with a trusted IdP, admin controls who enters in Zitadel; extra lazyit step is friction | ADR-0038 must document: assumes trusted IdP; if a customer wants stricter policy, Option 3 (pending activation) added as an optional mode later |

---

## Superseded decisions

| Old ADR | Superseded by | Reason |
|---------|--------------|--------|
| ADR-0013 (custom ZodValidationPipe) | ADR-0018 (nestjs-zod global pipe) | nestjs-zod provides the pipe + Swagger integration |
| ADR-0019 actor source (body-supplied) | ADR-0024 (ActorService + X-User-Id shim) | Consolidated actor resolution; removed body actor |
| ADR-0022 + ADR-0016 (auth shim) | Future auth implementation ADR (TBD) | Will be superseded when IdP integration lands |

---

## Open questions (not yet decided)

| Question | Blocker | How to unblock |
|----------|---------|---------------|
| **IdP / provider choice** (Authentik vs Keycloak vs Zitadel) | Blocks auth epic design | CEO decision; escalate with options + recommendation |
| **IdP database** (shared Postgres vs own Postgres) | Blocks DevOps prompt | CEO decision; part of IdP choice |
| **Bring-your-own-IdP config surface** | Blocks auth architecture | Part of auth epic scope; decide during auth epic |
| Async workers (BullMQ + Redis) | SEC-002 fix, future .docx robustness | CEO decision; an ADR needed before implementation |
| CD / image publishing (GHCR + deploy flow + tagging) | Deferred in ADR-0027 | When a deploy target exists |
| E2E testing tooling | Deferred in ADR-0012 | When auth + critical flows exist |
| Settings backend | Deferred | No trigger yet |
| Frontend pagination implementation | Contract in ADR-0030 | When a list grows or auth gates it |

---

## Update protocol

Update when:
- A new ADR is accepted → add entry under the right category
- An ADR is superseded → move to the superseded section, link both
- A non-ADR strategic decision lands → add to "Decisions made outside ADRs"
- An open question is resolved → move from "open" to its category
