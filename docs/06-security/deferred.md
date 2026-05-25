---
title: Deferred / accepted risks
tags: [security, deferred]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# Deferred / accepted risks

Risks that are **already documented, conscious debt** in an ADR. They are **not** new findings: they
were decided deliberately, with a stated mitigation or revisit trigger. Listed here so a reader knows
they were seen and weighed (not missed), and so a regression *against* the ADR can be told apart from
the accepted baseline.

> If the implementation **diverges** from one of these ADRs, or you judge an ADR **underestimates** the
> risk, that is a finding — open a `SEC-NNN` in `issues/` and link the ADR. The shim implementation was
> checked against ADR-0022 (see DEF-002) and currently **matches** it.

## DEF-001 — The whole API is unauthenticated (no guards)

- **ADR:** [[0016-auth-strategy-deferred]] (accepted). **Risk owner:** auth work (future IdP/OIDC).
- Every endpoint is open: anyone who can reach `:3001` can read/create/update/(soft-)delete every
  entity. Accepted as **dev-only** — "Current endpoints are for local development only… do not expose
  this build publicly."
- **Why not a finding:** explicitly decided and bounded to dev. **Trigger to revisit:** the first
  endpoint that needs real identity, or any plan to expose the build. If exposed publicly this is, in
  effect, Critical — that conditional severity is reflected in [[summary]], not re-filed here.
- **Highest-sensitivity instance:** the Access pillar (ADR-0023). `GET /access-grants` exposes "who can
  access what" — including `accessLevel: admin` on `isCritical` applications — to any caller. Under the
  no-auth posture this is the same accepted root, but it is the most valuable recon target if exposed,
  so it should be among the first endpoints placed behind auth.

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

## DEF-003 — Swagger docs are public

- **ADR:** [[0018-api-documentation-swagger]] (accepted). `GET /api/docs` and `/api/docs-json` are
  unauthenticated. Accepted because the API itself is unauthenticated and dev-only.
- **Why not a finding:** consistent with DEF-001; protecting the docs is explicitly deferred to the auth
  work. (It does enumerate the full surface to an attacker — relevant only once exposed.)

## DEF-004 — `metadata` / `specs` jsonb is unvalidated

- **ADRs:** [[0007-flexible-asset-specs-jsonb]], [[0021-knowledge-base-design]] (accepted debt).
- `Asset.specs`, `AssetModel.specs` and `Article.metadata` are `z.record(z.string(), z.unknown())` — any
  JSON object. Documented as debt, to be tightened per-category later.
- **Why not a finding (server-side):** the value is stored and returned, not deserialized into behavior;
  Express's ~100 kB JSON body limit bounds size. **Residual risk is at the downstream sink** — a frontend
  that trusts `metadata` (renders it, uses it in URLs, etc.) could turn it dangerous. Re-examine in the
  Phase-3 frontend review; relates to [[SEC-003|SEC-003]] (untrusted content → web sink).

## DEF-005 — Assignment actor FKs are client-supplied

- **ADRs:** [[0019-asset-assignment-integrity]] + the no-auth posture ([[0016-auth-strategy-deferred]]).
- `assignedById` / `releasedById` come from the request body (`CreateAssetAssignmentSchema`,
  `ReleaseAssetAssignmentSchema`); a caller can claim any actor. This is the same root as DEF-001/DEF-002:
  with no auth, the actor cannot be trusted.
- **Why not a finding:** consistent with the accepted no-auth posture; when auth lands these should come
  from the verified caller, not the body (same fix shape as [[SEC-006|SEC-006]] / DEF-002).
- **Now explicitly tracked by [[0023-access-management-design]]:** its "Follow-ups" call to *retrofit
  AssetAssignment to the `X-User-Id` shim*. The newer AccessGrant already takes the actor from the shim
  (validated, header-only — `access-grants.service.ts:154`), so AssetAssignment is the known laggard,
  not a fresh divergence. Convergence is a planned task, not a finding.

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
