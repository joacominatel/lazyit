---
title: Deferred / accepted risks
tags: [security, deferred]
status: draft
created: 2026-05-25
updated: 2026-06-02
---

# Deferred / accepted risks

Risks that are **already documented, conscious debt** in an ADR. They are **not** new findings: they
were decided deliberately, with a stated mitigation or revisit trigger. Listed here so a reader knows
they were seen and weighed (not missed), and so a regression *against* the ADR can be told apart from
the accepted baseline.

> If the implementation **diverges** from one of these ADRs, or you judge an ADR **underestimates** the
> risk, that is a finding — open a `SEC-NNN` in `issues/` and link the ADR. The shim implementation was
> checked against ADR-0022 (see DEF-002) and currently **matches** it.

## DEF-001 — Authn/authz on the API ✅ RESOLVED (2026-06-01)

- **History:** originally "the whole API is unauthenticated (no guards)" — every endpoint open, accepted
  as **dev-only** under [[0016-auth-strategy-deferred]].
- **Now resolved in two steps:**
  - **Authentication** ([[0038-jit-user-provisioning]]): a global `JwtAuthGuard` validates the OIDC
    Bearer JWT (or the `X-User-Id` shim when `AUTH_MODE=shim`) on every non-`@Public()` route and sets
    `request.user`.
  - **Authorization (RBAC)** ([[0040-rbac-roles]]): a `RolesGuard` composes after the auth guard and
    enforces `@Roles()`. Access-grant writes, Users administration and all destructive deletes are
    `ADMIN`-only; `MEMBER` does ordinary inventory/KB/asset writes; `VIEWER` is read-only.
- **Residual / to verify:** reads (`GET`) are still open to any authenticated user — including
  `GET /access-grants`, which exposes "who can access what". That is by design (any authenticated team
  member can see the access map) but is the most sensitive read; a future tightening to ADMIN-only is a
  judgement call, not a regression. The `X-User-Id` shim remains forgeable (see DEF-002) and is dev-only.

## DEF-002 — `X-User-Id` is a forgeable identity shim

- **ADR:** [[0022-draft-visibility-auth-shim]] (accepted, temporary), on [[0016-auth-strategy-deferred]].
- The KB derives `currentUser` from the `X-User-Id` header; anyone can send any user id. The ADR states
  plainly: "there is **no real enforcement**… insecure until auth lands… must not be exposed publicly."
- **Implementation checked — matches the ADR:** author is taken from the shim, never the body
  (`CreateArticleSchema` has no `authorId`); a non-author's view of a draft returns **404** (no existence
  leak), a non-author write on a published article returns **403**, an invalid/absent shim on writes
  returns **400** (`articles.service.ts:231-276`). No divergence → no finding.
- **Trigger to revisit:** when auth lands, `currentUser` must come from the verified token (`sub` →
  `User.externalId`), and the same rules must hold. Track [[SEC-006|SEC-006]]: `externalId` should be
  server-set by then, not client-set.

## DEF-003 — Swagger docs are public ✅ RESOLVED (2026-06-02)

- **ADR:** [[0018-api-documentation-swagger]] (accepted). `GET /api/docs` and `/api/docs-json` are
  unauthenticated. Originally accepted because the API itself was unauthenticated and dev-only —
  consistent with DEF-001; protecting the docs was deferred to the auth work.
- **Why the rationale went stale:** DEF-001 is now **resolved** — every non-`@Public()` route requires
  a Bearer JWT ([[0038-jit-user-provisioning]]). So the anonymous OpenAPI doc became the **one**
  anonymous surface enumerating the full *authenticated* attack surface — no longer "just describing an
  open API". That makes it a finding: [[SEC-009|SEC-009]] (info-leak, Low).
- **Resolved** (belt-and-suspenders, [[SEC-009|SEC-009]], closed in the same PR as
  [[SEC-010|SEC-010]]): (1) `apps/api/src/main.ts` mounts Swagger **only** when
  `NODE_ENV !== 'production'`, so a prod server doesn't serve it at all; (2) `infra/caddy/Caddyfile`
  no longer forwards `/api/docs*` on the public origin. The docs stay reachable on the internal Docker
  network and in local dev (DX unchanged). Residual: deliberate internal/dev reachability only.

## DEF-004 — `metadata` / `specs` jsonb is unvalidated

- **ADRs:** [[0007-flexible-asset-specs-jsonb]], [[0021-knowledge-base-design]] (accepted debt).
- `Asset.specs`, `AssetModel.specs` and `Article.metadata` are `z.record(z.string(), z.unknown())` — any
  JSON object. Documented as debt, to be tightened per-category later.
- **Why not a finding (server-side):** the value is stored and returned, not deserialized into behavior;
  Express's ~100 kB JSON body limit bounds size. **Residual risk is at the downstream sink** — a frontend
  that trusts `metadata` (renders it, uses it in URLs, etc.) could turn it dangerous. Re-examine in the
  Phase-3 frontend review; relates to [[SEC-003|SEC-003]] (untrusted content → web sink).

## DEF-005 — Assignment actor FKs are client-supplied · ✅ partially resolved (2026-05-25)

- **ADRs:** [[0019-asset-assignment-integrity]] → [[0024-asset-assignment-actor-shim]] + the no-auth
  posture ([[0016-auth-strategy-deferred]]).
- **Original concern:** `assignedById` / `releasedById` came from the request **body**
  (`CreateAssetAssignmentSchema`, `ReleaseAssetAssignmentSchema`); a caller could claim any actor.
- **Resolved:** [[0024-asset-assignment-actor-shim]] removed both from the body. The actor is now
  read from the optional, **validated** `X-User-Id` header (well-formed UUID + live user, else `400`),
  exactly like AccessGrant (`asset-assignments.service.ts` `resolveActor`). The two append-only joins
  now share one actor model — the body-supplied-actor divergence is gone.
- **Residual (rolls into DEF-001):** the `X-User-Id` header is itself spoofable until real auth lands
  ([[0022-draft-visibility-auth-shim]] security note). That residual is the shared no-auth posture, not
  a per-endpoint finding; when auth arrives the actor comes from the verified caller (same fix shape as
  [[SEC-006|SEC-006]] / DEF-002).

---

## Clean today (checked, nothing to file)

Cheap invariants verified this sweep — re-check each pass (a regression here *would* be a finding):

- **No SQL injection** — no `$queryRaw`/`$executeRaw`; all access is parameterized Prisma.
- **No command injection** — no `child_process`/`exec`/`eval`/`new Function`.
- **No path traversal in import** — the uploaded file is parsed from a buffer and **never written to
  disk**; the filename feeds only extension detection + title (path stripped, `article-import.ts:42`).
- **No sensitive logging** — no logger/`console` in `apps/api/src` (nothing to leak; also no audit log
  yet — a feature gap, not a vuln).
- **Mass assignment mostly contained** — create/update schemas are `z.strictObject` (unknown keys
  **rejected**) and omit server-owned fields (`authorId`, article `status`, `id`, timestamps). The
  exception is [[SEC-006|SEC-006]] (`externalId`).
- **Assignment create race is backstopped** — the `findFirst` pre-check is friendly only; the partial
  unique index `WHERE releasedAt IS NULL` is the race-proof guard (P2002 → 409). Correct pattern.
- **Soft-delete filtering is consistent** — `deletedAt: null` on every read and on shim user resolution.
- **No committed secrets** — `.gitignore` excludes `.env*` except `.env.example`; only `*.example`
  files are tracked.

Related: [[summary]] · `.claude/skills/lazyit-sentinel/SKILL.md` · [[03-decisions/_MOC|Decisions (ADRs)]]
