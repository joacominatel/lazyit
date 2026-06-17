---
title: "ADR-0069: Migrator — guided bulk import (phase 1: Asset slice, JSON + CSV)"
tags: [adr, migrator, import, asset, backend, frontend, shared, settings]
status: accepted
created: 2026-06-17
updated: 2026-06-17
deciders: [Joaquín Minatel]
---

# ADR-0069: Migrator — guided bulk import (phase 1: Asset slice, JSON + CSV)

## Status

**accepted** — 2026-06-17 (CEO delegated the architecture call to the CTO and confirmed; *"si crees que es la mejor forma de importar cosas de forma masiva, podemos adaptarlo"*). Issue #620. Backed by the strict pre-ADR analysis
(`docs/03-decisions/0069-migrator-import.ANALYSIS.md`, ~20-agent review grounded in verified code).
Builds on [[0005-id-strategy]], [[0006-soft-delete-and-auditing]], [[0007-flexible-asset-specs-jsonb]],
[[0041-soft-delete-reuse-and-restore]], [[0046-rbac-v2]], [[0053-async-workers-bullmq-valkey]],
[[0054-applications-workflow-engine]] (transactional-outbox), [[0063-configurable-asset-tag-scheme]],
[[0068-asset-tag-existing-estate-awareness]].

## Context

Bootstrapping a real instance means loading an existing estate (assets, people, apps) that today lives in
spreadsheets and legacy tools. The analysis established the migrator is **not one feature but five welded
subsystems**: (1) an untrusted-file parse/coerce layer (**no CSV/JSON-array parser exists** in the repo),
(2) a natural-key → FK **reference-resolution engine** (no create path has one — every Create schema takes
already-resolved `cuid`/`uuid` ids), (3) the interactive conflict resolver, (4) a **stateful multi-request
wizard** (the only precedent, KB article import, is single-shot fire-and-forget), and (5) a per-row commit
loop that preserves transactional history + actor attribution at scale.

Verified hard constraints that shape this ADR:

- **User import is categorically different** — each row is a synchronous Zitadel write-back that
  hard-deletes the local row and 503s on failure (`users.service.ts:474–533`); `role` is an ADMIN-escalation
  vector; first-user→ADMIN. → **deferred** (CEO decision).
- **`currentStock` cannot be set via the create schema** → consumable import deferred.
- **Soft-deleted rows are invisible to normal reads** → "create new" silently 409s unless conflict
  detection uses `includeSoftDeleted` → a fourth conflict outcome (restore) is required.
- **No `import` permission exists** in the frozen RBAC catalog.
- **Locked decisions (do not relitigate):** JSON + CSV; conflicts resolved interactively per-conflict
  (match / restore / create / skip — never wipe, additive only); history import deferred to phase 2.

> **CEO, verbatim (2026-06-17):**
> - *(scope)* *"Si el slice fino al menos para arrancar no está mal, CSV o JSON diría yo. Que puedas
>   mapear: nombre, serial number, asset tag (establecerlo incluso dentro, recuerda la secuencia) o elegir
>   si usar el existente si existe o hacer uno de 0, el nombre, el location, el modelo, la categoría, etc.
>   Todo lo que pertenece a un asset."*
> - *(users)* defer user import to a separate hardened path.

## Decision

**Phase 1 ships exactly one entity — `Asset` — importable from JSON or CSV.** It builds the full machinery
(parse/coerce, reference resolution, the interactive conflict menu, the stateful wizard, the per-row commit)
on the pure-DB asset path, deliberately avoiding the IdP/stock/side-effect specials so the architecture is
proven before phase 2 layers on more entities.

### 1. Wizard architecture — dry-run → persisted plan → replay-at-commit

The locked "resolve each conflict by hand" decision needs a human in the loop, but bulk work must run async.
We resolve the contradiction with a fixed five-step shape; **no human is ever in the loop mid-commit**:

1. **Upload (sync):** auth + `import:run`, content-type sniff, size cap, multipart only → `202` + `sessionId`.
2. **Parse (async, sandboxed):** forked child parses + counts + normalizes rows into `ImportRow` rows;
   returns detected headers, dialect, encoding, and the record count for confirmation.
3. **Map (sync):** operator confirms column→field / value→enum / field→FK mappings.
4. **Dry-run (sync):** the **full** validate + coerce + reference-resolve + conflict-detect pipeline
   (`includeSoftDeleted`), **writing nothing**; produces per-row outcomes + the distinct-conflict set. The
   operator resolves each conflict once; the result is frozen into a **persisted resolution plan**.
5. **Commit (async, chunked):** replays the plan, **re-validating per row** (estate may have drifted), and
   reports per-row outcomes.

### 2. State model

New `ImportSession` (`cuid`, owner-scoped, `status`, `expiresAt` = 24h) + child `ImportRow`
(`autoincrement` — thousands per session). Both are **transient**: explicitly **excluded from
`SOFT_DELETABLE_MODELS`** and hard-deleted by a GC sweep following the existing **`setInterval`** sweeper
pattern (`notifications-retention.sweeper.ts`; `@nestjs/schedule` is not installed). The raw file is
**parsed once and discarded** (no blob store, no PII at rest beyond the parsed rows under TTL). The resolved
**actor is captured at upload** and carried into the DI-less worker child.

### 3. Coercion pre-pass + validation (single-sourced)

CSV is "everything-is-a-string and flat"; the strict `CreateAssetSchema` cannot validate raw rows. A
**coercion/normalization pre-pass lives in `@lazyit/shared`** and feeds the **unchanged** `CreateAssetSchema`
(never a looser import schema — drift would break soft-delete/uniqueness/normalization invariants). It:
trims; treats `''`/whitespace/null-tokens as **absent** (so `.optional()`/`.default()` fire); re-emits every
date via `toISOString()` (because `z.iso.datetime()` rejects bare dates *and* numeric-offset RFC-3339);
coerces numbers/booleans/enums with declared locale; case-insensitive enum + synonym maps. **The same
coercion runs in the web preview and the API commit** so the preview cannot lie.

### 4. Mapping model — three explicit layers

- **column → field:** target list is **generated from the `CreateAssetSchema` key set**; auto-suggest by
  normalized header match is **suggestion-only, operator-confirmed, never auto-applied**; unmapped columns
  are **dropped before validation** (strictObject 400s on unknown keys). Mappable: `name`, `serialNumber`,
  `assetTag`, plus the FK-resolved `category` / `model` / `location`. Required-no-default fields (`name`,
  `status`) must be **mapped or given a constant** before mapping can complete.
- **value → enum:** `status` (and later LocationType/AccessLevel) are **closed enums** — a value-map with
  synonym auto-suggestions (`active→OPERATIONAL`, `retired→RETIRED`), not a match/create conflict.
- **field → FK resolution:** see §5.

### 5. Reference resolution

A first-class, **value-deduplicated, dependency-ordered** subsystem (category → model → asset), resolving
each distinct natural-key value **once** (cached, like the KB folder resolver), with an `includeSoftDeleted`
probe. Per-entity natural keys + **per-key normalization** (mirror the schemas: **trim-only**, no
internal-whitespace collapse): **category / location by normalized name**; **AssetModel by `sku`** (exact,
case-sensitive) else a *soft* case-folded `(manufacturer, name)` match offered as **candidates**. Because
`AssetModel.name` and person names are **not unique**, resolution **never auto-picks** on ambiguity — it
surfaces candidates. (Asset ownership/assignment is **not** a `CreateAssetSchema` field and is **out of
phase 1**.)

### 6. Conflict model — four outcomes, persisted

For each distinct `(entity, field, normalizedValue)` conflict: **match-live** / **restore-ghost** (a
soft-deleted match) / **create-new** (only when no live match) / **skip**. Resolved **once per normalized
value** (not per row), persisted append-only into the resolution plan (immutable once commit starts).
**Skip cascade is explicit** — skipping a category/model never silently nulls the FK on dependent rows; the
operator chooses "import the N rows without the link" vs "skip the N rows".

### 7. Asset-tag handling (per CEO + [[0068-asset-tag-existing-estate-awareness]] §1)

Per row, three modes:

- **(a) Explicit tag from the file** → inserted as-is, defended by the live partial-unique index
  `assets_assetTag_active_key`. Imported explicit tags count as **occupied** for the scheme's
  **skip-existing invariant** (ADR-0068 §1), so a later auto-mint never collides with them. An explicit tag
  that collides with an existing live tag is surfaced as a **per-row conflict** (never silently dropped).
- **(b) Use existing** — when the row matches an already-existing asset, keep its tag (match path).
- **(c) Auto-mint** — no tag provided + scheme enabled → allocate the next free number via the scheme
  (gaps accepted, skip-existing). Explicit tags always win over auto-mint.

The pre-skip step of ADR-0068 §1 makes a dense bulk import collision-free without false 409s; this ADR adds
no new tag-allocation semantics, only feeds explicit imported tags into the existing invariant.

### 8. Commit contract

- **Unit of atomicity = one row + its history** in a single transaction, routed through
  **`AssetsService.create()`** (never `createMany`) so the `CREATED` `AssetHistory` row, the actor, and all
  invariants fire. Provenance `{ source: 'import', importRunId }` is stamped into the CREATED event's jsonb
  payload (no enum migration — mirrors the `SPECS_CHANGED`-reuse precedent).
- **Per-row best-effort, KEEP-PARTIAL, resumable:** `P2002`/`P2003` are caught **per row** and recorded as a
  per-row failure ("value taken since preview"), **never aborting the batch**; re-running the session skips
  `COMMITTED` rows. (Rollback across a partial import is not offered — it is additive and audited.)
  *Follow-up: confirm `PrismaExceptionFilter` maps `P2003`→400, not a 500.*

### 9. Idempotency & audit

Resume-within-session by `ImportRow` status. **Re-uploading a file is NOT deduped** unless `serialNumber` is
mapped (the only asset natural key) — the UI **warns loudly**. An append-only **`ImportRun`** ledger records
who/what/when, counts, conflict summary, and the file **hash** (never contents) for audit and a future undo
correlation id.

The ledger is **durable beyond its session** ([[0006-soft-delete-and-auditing]] — an append-only ledger is
never deleted). The `ImportSession`/`ImportRow` scratch is GC-hard-deleted 24h after upload, but `ImportRun`
**survives** that sweep: its `sessionId` is a **plain durable String column, deliberately NOT a cascading
FK** (an `onDelete: Cascade` FK would let the session GC reap the audit-of-record). The session→run
correlation rides that retained value, and the asset→import correlation rides the CREATED-event `sessionId`
provenance (§8) — so reaping the transient session loses no audit. The GC sweeper therefore deletes only
`ImportSession` (cascading to `ImportRow`), **never `ImportRun`**.

### 10. Async, scale & side-effects

Parse runs in the **sandboxed forked child** (heap cap + record-count quota; inherits the multer cap and the
SEC-001/SEC-002 hardening of the article path). Commit is **chunked** (100–200 rows/tx) with
`job.updateProgress({ phase, processed, total })`, a raised `lockDuration` renewed between chunks; commit
jobs are idempotent (`attempts>1` ok), parse is `attempts:1`. **Side effects are suppressed during bulk
import** — the per-asset Meili upsert is skipped and a **single search reconcile** runs post-import.

### 11. Security

- **New `import:run` permission, ADMIN-only by default** (RBAC catalog addition, [[0046-rbac-v2]]) **AND** a
  **runtime per-target check at commit** (`asset:write`, plus `category:write` / `assetModel:write` /
  `location:write` for each create-new conflict action) via a `PermissionResolver` call inside the commit
  service — `@RequirePermission` can't express the AND because the target isn't known until after analyze.
  - **TOCTOU (accepted):** the per-target AND-check runs once at `enqueueCommit` (initiation), not
    re-checked inside the async worker. If the actor is downgraded between enqueue and processing, the
    worker still commits under the authorization captured at initiation. Acceptable for an async job
    (the commit is additive + audited, the actor is captured at enqueue, and the job runs in seconds);
    re-resolving the actor's role per chunk in the worker is a deferred hardening, not a phase-1 need.
  - **`import:run` is also human-only at Layer 1:** it is in `SERVICE_ACCOUNT_UNGRANTABLE_PERMISSIONS`
    (`@lazyit/shared`), so an admin can't even persist a (non-functional, guard-blocked) `import:run`
    grant on a service account — mirroring the #555 SA-ungrantable pattern. Layer 2 (the
    `ServicePrincipalForbiddenGuard` on the import controller) is the runtime backstop.
- **Mass-assignment closed by construction:** mappable fields are **only** `CreateAssetSchema` keys;
  `id`, `externalId`, actor/lifecycle columns are non-mappable because they are absent from the schema.
- CSV-formula leading chars neutralized on free-text fields; session id **owner-scoped** (no IDOR); no
  `@Public`; **PII-free logs** (counts + conflict summaries only).

### 12. Explicit deferrals

`specs`/`metadata` free mapping (until [[0007-flexible-asset-specs-jsonb]] per-category validation lands);
asset **ownership/assignment**; **users** (separate hardened path — per-row skip-and-report, ADMIN-only,
`role` forbidden, `externalId` rejected); **consumables** (the `currentStock`-via-seeding-movement question);
**applications**; **AccessGrant**; **history backfill**. `.xlsx` is rejected with an actionable
"export to CSV UTF-8" message. Foreign `createdAt`/`updatedAt`/`deletedAt` columns are rejected (phase 1 is
current-state only).

### 13. Manual

The in-app `/help` Manual gets an Importer page in **en + es** in the same change ([[CLAUDE.md]] #7),
including the bilingual UX copy for the conflict menu, ghost-restore, partial-success, and the
"history is phase-2" notice.

## Implementation notes (wave 4a — commit engine, #633)

The write path (§8/§10) landed in `apps/api/src/import/import-commit.{service,worker}.ts`. Several
decisions worth recording, all consistent with the ADR:

- **The commit worker is IN-PROCESS, not a sandboxed forked child** (unlike the parse worker). The
  commit MUST route every write through the Nest-DI `AssetsService.create()` to preserve the CREATED
  history, actor attribution and asset-tag invariants — a DI-less forked child can't reach those. The
  bomb-isolation that justified a forked *parse* child does not apply at commit time (the file bytes
  were parsed and discarded in wave 2; the commit replays already-stored `ImportRow`s). Mirrors the
  `WorkflowRunWorker` pattern. Concurrency 1; idempotent so a BullMQ retry replays cleanly.
- **Create-new references use audit-honest phase-1 defaults for required-no-default fields** the
  resolution plan can't carry: a created `Location` gets `type: OTHER`, a created `AssetModel` gets
  `manufacturer: 'Unknown'` (the natural-key value is the only create input the dry-run captures). The
  operator can edit these later; nothing is silently dropped. Upgrade path: thread richer per-reference
  fields through the plan when the wizard lets the operator fill them.
- **Side-effect suppression is SCOPED to the import's own asset writes** (§10): each commit `create()`
  is passed `suppressSearch: true` so it skips ITS OWN per-row Meili upsert, and ONE
  `rebuildIndex('assets', …)` reconcile runs after the bulk. There is **no process-wide suppression** —
  an earlier global `SearchService` depth-counter was retired because it silently dropped EVERY
  concurrent non-import write (articles, users…) for the duration of a multi-second commit while the
  post-commit reconcile only rebuilt `assets`. The `create()` signature gains an optional
  CREATED-event provenance payload (`{ source:'import', sessionId, rowIndex }`, §8/§9 — no history-enum
  migration).
- **Integrity hardening (wave-4a review).** A rigorous PR review tightened the write path before merge,
  all within the ADR: **(a)** `enqueueCommit`/`commit` are status-gated — a non-`DRY_RUN` (and
  non-resuming-`COMMITTING`) session is rejected with `ConflictException`, and the enqueue uses a
  deterministic `jobId = sessionId` so a double-enqueue can't mint a second `ImportRun` + duplicate
  assets. **(b)** The `ImportRun` ledger is written **once, after the loop, with final counts** (true
  append-only per [[0006-soft-delete-and-auditing]]) — never inserted-zeroed-then-updated, so a
  mid-batch worker throw never leaves stale counts; asset→import correlation rides the stable
  `sessionId` stamped into CREATED provenance (not the autoincrement run id, unknown until after the
  loop). **(c)** The two-write `create()`→`markRow('COMMITTED')` window is closed: on resume, before
  re-creating a non-COMMITTED row we probe the CREATED provenance for an asset already created for
  `(sessionId, rowIndex)` and reconcile the row instead of duplicating. **(d)** `createReference` is now
  **find-or-create by natural key** (live-row lookup first) — idempotent across the `attempts:3` retry
  budget — plus a per-run **negative memo** so a doomed create is attempted once, not per dependent row.
- **Row-level `skipped`** is in the `ImportCounts`/`ImportRun` shape but stays 0 in phase 1: the wave-3
  plan only expresses a *reference-level* skip (drop the FK, keep the row), not an operator "skip these
  N rows" outcome. Reserved for a later wave.

Out of this wave (per #633): HTTP controllers, the `import:run` permission, runtime authz, the GC
sweeper, and the frontend — all wave 4b.

## Implementation notes (wave 4b — HTTP + RBAC surface, #635)

The wizard's HTTP surface + its authorization landed in `apps/api/src/import/import.controller.ts`,
with the catalog change in `@lazyit/shared`. All consistent with §1/§11:

- **Endpoints (all owner-scoped, `import:run`-gated, human-only).** `POST /imports` (multipart, multer
  size cap → 202 + sessionId), `GET /imports/:id` (status + detected shape + rows), `POST
  /imports/:id/mapping` (confirm mapping → MAPPED), `POST /imports/:id/dry-run` (writes nothing → the
  report), `POST /imports/:id/plan` (freeze the resolution plan → DRY_RUN), `POST /imports/:id/commit`
  (→ `enqueueCommit`, 202), `GET /imports/:id/result` (the `ImportRun` ledger view). Mirrors the KB
  article-import upload (`FileInterceptor` + `limits.fileSize`, SEC-001) and its human-only gate.
- **Human-only is the existing `ServicePrincipalForbiddenGuard`** at the controller class level — a
  service account is 403'd outright on every route regardless of grants (so `import:run` is never
  exploitable by a bot), plus a defence-in-depth `ownerId()` check inside the controller. The actor is
  always the principal's `user.id`; never a body/header field.
- **`import:run` is a new RUN-ONLY domain in the frozen catalog** (ADR-0046). The `import` domain has a
  single coarse `import:run` verb — no `:read`/`:write`/`:delete` (a session is owner-scoped transient
  scratch, not a browsable domain). As a coarse verb it is **ADMIN-only by construction of the seed**
  (it never enters the MEMBER/VIEWER default sets), so no seed/golden-matrix value changes — only the
  catalog grows. Two `@lazyit/shared` covering-set tests were updated to admit the new domain: the
  "every domain has a `:read`" invariant became "every domain has ≥1 permission, and every
  read-surfaced domain a `:read`" (with `import` the explicit run-only exception), and the exact
  coarse-verb list gained `import:run`. **This is the only behavior-relevant catalog change** and is
  the one authorized by §11.
- **Runtime per-target AND-check** lives in `ImportCommitService.enqueueCommit` (the committable seam):
  it derives the exact write-permission set the frozen plan needs — `asset:write` always, plus
  `assetModel:write`/`location:write`/`category:write` for each `create`/`restore` conflict outcome (a
  `match` links a live row and needs no write) — and AND-checks the actor's DB-resolved role via
  `PermissionResolverService.hasAll`, 403'ing a gap **before any row is written**. ADMIN short-circuits
  to the full catalog (so ADMIN always passes); a missing/deleted actor fails closed.
- **GC sweeper** (`import-session-gc.sweeper.ts`) mirrors `NotificationsRetentionSweeper`: a plain
  `setInterval` (unref'd, re-entrancy guarded, skipped under `NODE_ENV=test`, best-effort) that
  hard-deletes sessions past `expiresAt`, **excluding any mid-commit (`COMMITTING`) session**. The FK
  cascade (`onDelete: Cascade`) reaps the session's `ImportRow`s **only**. The **`ImportRun` ledger is
  NOT reaped** — it is the append-only audit-of-record (§9, [[0006-soft-delete-and-auditing]]), so it must
  outlive the transient session it describes. To make that survive, `ImportRun.sessionId` is a **durable
  plain String column, NOT a cascading FK** (migration `…_import_run_ledger_survives_session_gc` drops the
  original `import_runs_sessionId_fkey`); the session→run correlation is the retained value, and the
  asset→import correlation rides each created asset's `CREATED` `AssetHistory` provenance
  (`{ source:'import', sessionId, rowIndex }`). The sweeper touches only `ImportSession` (its rows
  cascade), never `ImportRun`.

## Consequences

- **Positive:** ships the #1 real bootstrap need (bulk asset onboarding); proves every hard subsystem
  (parse/coerce, FK resolution, conflict menu, stateful wizard, per-row commit) on the safe pure-DB path;
  additive + dry-run + audited, so a bad import never corrupts or deletes.
- **Trade-offs (accepted):** a new `ImportSession`/`ImportRow` surface + sandboxed parse + a coercion layer
  in `@lazyit/shared`; KEEP-PARTIAL (no cross-import rollback); explicit-tag collisions are surfaced, not
  auto-resolved; re-upload is not deduped without a mapped serial.
- **Follow-ups (issue #620):**
  - **Backend:** pick + pin the CSV parser via Context7 (RFC-4180, `bom:true`, streaming); the coercion +
    `normalizeMatchKey` + synonym tables in `@lazyit/shared` (unit-tested); the reference-resolution engine;
    `ImportSession`/`ImportRow`/`ImportRun` models + migration (excluded from soft-delete); the parse +
    chunked-commit workers; the `import:run` permission + runtime commit-time AND-check; a row-index-keyed
    result schema in `@lazyit/shared`; the GC `setInterval` sweeper; Jest coverage (coercion, resolution
    ambiguity, four conflict outcomes, ghost restore, per-row P2002/P2003 keep-partial, asset-tag explicit
    vs auto-mint, dry-run-writes-nothing).
  - **Frontend:** the upload → map → dry-run → commit wizard; the conflict-resolution UI (match/restore/
    create/skip with counts + blast radius); progress; result report; en + es i18n.
  - **Docs:** the [[asset]] entity note (import semantics); the en+es Manual page.

**Related:** #620 · the pre-ADR analysis doc · [[0063-configurable-asset-tag-scheme]] ·
[[0068-asset-tag-existing-estate-awareness]] · [[0007-flexible-asset-specs-jsonb]] ·
[[0006-soft-delete-and-auditing]] · [[0053-async-workers-bullmq-valkey]] · [[0046-rbac-v2]]
