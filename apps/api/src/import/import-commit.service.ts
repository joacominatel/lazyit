import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  assetImportDescriptor,
  coerceRow,
  CreateAssetSchema,
  CreateAssetModelSchema,
  CreateAssetCategorySchema,
  ImportResolutionPlanSchema,
  ImportMappingSchema,
  IMPORT_DESCRIPTORS,
  normalizeMatchKey,
  type ConflictResolution,
  type CreateAsset,
  type ImportMapping,
  type ModelConfig,
  type ImportResolutionPlan,
  type Permission,
} from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AssetsService } from '../assets/assets.service';
import { AssetModelsService } from '../asset-models/asset-models.service';
import { AssetCategoriesService } from '../asset-categories/asset-categories.service';
import { LocationsService } from '../locations/locations.service';
import { SearchService } from '../search/search.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import type { Principal } from '../auth/principal';
import { projectAsset } from '../search/search.documents';
import { isQueueUnavailableError } from '../queue/redis-connection';
import type { CommitJobData, CommitJobResult } from './import-commit.types';
import {
  COMMIT_CHUNK_SIZE,
  IMPORT_COMMIT_JOB_NAME,
  IMPORT_COMMIT_QUEUE,
} from './import-commit.constants';

/**
 * The migrator COMMIT ENGINE (ADR-0069 §8/§10, wave 4a, #633) — the WRITE path. Given a session whose
 * dry-run produced a frozen resolution plan, it REPLAYS that plan (never re-resolves) and actually
 * creates the assets, one row at a time, through the real `AssetsService.create()` so every invariant
 * fires (CREATED history, actor attribution, asset-tag allocation, SEC-008 url guard, normalization).
 *
 * Contract (ADR-0069 §8):
 *   - Unit of atomicity = one row + its CREATED history, in a single `create()` transaction.
 *   - Provenance `{ source: 'import', importRunId }` is stamped into the CREATED event's jsonb payload
 *     (no new history enum — mirrors the SPECS_CHANGED-reuse precedent).
 *   - KEEP-PARTIAL + RESUMABLE: per-row `ImportRow` status; a re-run skips COMMITTED rows. A per-row
 *     `P2002`/`P2003` ("value taken since preview") is recorded as a FAILED row, NEVER aborts the batch.
 *   - Re-VALIDATE each row (`CreateAssetSchema.safeParse`) — the estate may have drifted since dry-run,
 *     and validating BEFORE `create()` means a doomed row never burns a tag-scheme counter number.
 *   - Reference outcomes: match/restore → use the resolved FK; create → create the ref ONCE (memoized);
 *     skip → omit the FK (import the row without the link — never silently null a different FK).
 *   - Side effects suppressed during the bulk — each `create()` is passed `suppressSearch:true` so it
 *     skips its OWN per-row Meili upsert (scoped, NOT a process-wide mute); ONE reconcile post-commit.
 *
 * SECURITY: owner-scoped reads; PII-free logging (counts + reasons only).
 */

/** A reference creation that the plan can't fully describe — phase-1 defaults for the required fields. */
const IMPORT_LOCATION_DEFAULT_TYPE = 'OTHER' as const;
const IMPORT_MODEL_DEFAULT_MANUFACTURER = 'Unknown';

/**
 * The brand + category resolved for ONE created `AssetModel` (ADR-0069 REDESIGN §4.4). Both are
 * optional: an absent `manufacturer` falls back to {@link IMPORT_MODEL_DEFAULT_MANUFACTURER}; an absent
 * `categoryName` means the created model gets no category link. Built per-row from `mapping.modelConfig`
 * (a pinned constant or the row's column cell), then carried into `createReference` — but a Model is
 * created AT MOST ONCE per natural-key value (memoized), so the FIRST row that triggers the create wins.
 *
 * ponytail: two flat fields, not a generic multi-level sub-descriptor. Ceiling: the brand/category of a
 * created model come from whichever row first mints it (deterministic at the value granularity since the
 * value IS the model name). Upgrade path: a richer per-reference field bag in the resolution plan.
 */
interface ModelCreateConfig {
  manufacturer?: string;
  categoryName?: string;
}

/**
 * Resolve the brand/category for a created model from the mapping's `modelConfig` + this row's cells
 * (ADR-0069 REDESIGN §4.4 / §5.1). A pinned `*Const` wins over the `*Column` cell; an empty/absent value
 * yields no entry. Trimmed; empty strings dropped so a blank cell never becomes a `''` manufacturer.
 */
function modelCreateConfigFor(
  modelConfig: ModelConfig,
  raw: Record<string, string>,
): ModelCreateConfig {
  if (!modelConfig) return {};
  const pick = (constVal?: string, column?: string): string | undefined => {
    const value = constVal ?? (column !== undefined ? raw[column] : undefined);
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  };
  return {
    manufacturer: pick(modelConfig.manufacturerConst, modelConfig.manufacturerColumn),
    categoryName: pick(modelConfig.categoryConst, modelConfig.categoryColumn),
  };
}

/**
 * Maps a resolution-plan reference `entity` to the write permission a CREATE-NEW / RESTORE outcome
 * needs (ADR-0069 §11 — the runtime per-target AND-check). A `match` outcome links an existing live
 * row and needs no write on the reference; only `create`/`restore` mutate the reference entity, so only
 * those gate on its write permission. `Category` is included for forward-safety even though phase-1
 * asset plans only ever surface AssetModel/Location conflicts (category linkage rides the model).
 */
const REFERENCE_WRITE_PERMISSION: Record<string, Permission> = {
  AssetModel: 'assetModel:write',
  Location: 'location:write',
  Category: 'category:write',
};

/** Prototype-pollution sentinels re-guarded at the specs write site (ADR-0069 REDESIGN §4.3 / §7). */
const SPECS_RESERVED_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Re-build a specs object with a NULL prototype and the reserved prototype-pollution keys skipped
 * (ADR-0069 REDESIGN §4.3 defense-in-depth). `coerceRow` already does this in shared (first line, UX);
 * this is the second line at the backend write site, so a corrupt/malicious persisted mapping that
 * bypassed the mapping `superRefine` still can't reach `Object.prototype`. `Object.create(null)` means
 * even a literal `__proto__` key (were it not skipped) lands as an own data property, never the proto.
 */
function sanitizeSpecs(specs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(specs)) {
    if (SPECS_RESERVED_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Resolution lookup key — mirrors the dry-run's `(entity, field, normalizedValue)` conflict identity. */
function resolutionKey(entity: string, field: string, normalizedValue: string): string {
  return `${entity}\u0000${field}\u0000${normalizedValue}`;
}

/**
 * Thrown when a `create`-outcome reference was already attempted and failed this run (negative memo,
 * ADR-0069 §9): a dependent row fails fast on this PII-free sentinel without re-hitting the DB.
 */
class ReferenceCreateFailedError extends Error {
  constructor(entity: string, field: string) {
    super(`Reference create for ${entity}.${field} already failed this run`);
    this.name = 'ReferenceCreateFailedError';
  }
}

@Injectable()
export class ImportCommitService {
  constructor(
    @InjectQueue(IMPORT_COMMIT_QUEUE) private readonly queue: Queue,
    private readonly prisma: PrismaService,
    private readonly assets: AssetsService,
    private readonly models: AssetModelsService,
    private readonly categories: AssetCategoriesService,
    private readonly locations: LocationsService,
    private readonly search: SearchService,
    private readonly permissions: PermissionResolverService,
  ) {}

  /**
   * Enqueue a commit for a DRY_RUN session owned by `actorUserId`. Owner-scoped + status-gated: only a
   * session the operator owns and that has a frozen resolution plan (status DRY_RUN) is committable —
   * never re-runs a COMMITTED one here. The actor is captured into the job (the worker can't re-derive
   * the principal — ADR-0069 §2). The HTTP controller + `import:run` permission are wave 4b; this method
   * is the seam the controller (and the tests) drive.
   */
  async enqueueCommit(
    sessionId: string,
    actorUserId: string,
  ): Promise<{ sessionId: string }> {
    const session = await this.prisma.importSession.findFirst({
      where: { id: sessionId, ownerId: actorUserId },
      select: { id: true, status: true, resolutionPlan: true },
    });
    if (!session || session.resolutionPlan === null) {
      throw new NotFoundException(`Import session ${sessionId} not found`);
    }
    // STATUS-GATED (ADR-0069 §8): only a session whose dry-run produced a frozen plan (status
    // DRY_RUN) is committable. Rejecting any other status stops a COMMITTED session from being
    // re-committed (which would mint a SECOND ImportRun + duplicate assets), and stops a concurrent
    // double-enqueue racing a COMMITTING one. FAILED is terminal here — recover by re-running the
    // dry-run, not by re-committing a half-applied plan.
    if (session.status !== 'DRY_RUN') {
      throw new ConflictException(
        `Import session ${sessionId} is not committable (status ${session.status}); only a DRY_RUN session can be committed.`,
      );
    }

    // RUNTIME PER-TARGET AND-CHECK (ADR-0069 §11): `import:run` (the route guard) is necessary but NOT
    // sufficient — the actor must ALSO hold the write permission for every entity this commit will
    // actually mutate, which is only knowable once the plan exists (so `@RequirePermission` can't
    // express it). A commit always creates assets (`asset:write`), and a `create`/`restore` conflict
    // outcome additionally creates/restores its reference entity (`assetModel:write`/`location:write`/
    // `category:write`). We AND-check the actor's role against that exact set and 403 on any gap — a
    // partial grant (e.g. `import:run` + `asset:write` but not `assetModel:write` for a plan that
    // creates a model) is denied BEFORE any row is written. The plan was validated at save time
    // (ImportResolutionPlanSchema); we re-parse defensively here.
    const plan = ImportResolutionPlanSchema.parse(session.resolutionPlan);
    await this.assertActorCanCommit(actorUserId, plan);

    const data: CommitJobData = { sessionId, actorUserId };
    try {
      await this.queue.add(IMPORT_COMMIT_JOB_NAME, data, {
        // A commit is idempotent (resumable — a re-run skips COMMITTED rows), so a transient infra
        // failure CAN safely retry, unlike the permanent parse failure.
        attempts: 3,
        // Deterministic jobId = the sessionId: BullMQ dedups by jobId, so two concurrent enqueues for
        // the same session collapse to ONE job (no double-commit / duplicate ImportRun from a fast
        // double-click or a controller retry).
        jobId: sessionId,
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 24 * 3600, count: 1000 },
      });
    } catch (err) {
      if (isQueueUnavailableError(err)) {
        throw new ServiceUnavailableException(
          'The import service is temporarily unavailable (the job queue is unreachable). Please try again in a moment.',
        );
      }
      throw err;
    }
    return { sessionId };
  }

  /**
   * The runtime per-target AND-check (ADR-0069 §11). Derives the EXACT write-permission set this
   * commit needs from the frozen plan — `asset:write` always (a commit creates assets), plus the
   * reference-entity write for each `create`/`restore` conflict outcome (a `match` links an existing
   * live row and needs no write) — then asserts the actor's DB-resolved role holds ALL of them. A gap
   * is a 403 BEFORE any row is written. The actor's role is read DB-first (INV-1) from the User row;
   * the resolver short-circuits ADMIN to the full catalog, so an ADMIN always passes. A missing/
   * deleted actor (no role) fails closed (403).
   */
  private async assertActorCanCommit(
    actorUserId: string,
    plan: ImportResolutionPlan,
  ): Promise<void> {
    const required = new Set<Permission>(['asset:write']);
    for (const conflict of plan.conflicts) {
      if (conflict.outcome !== 'create' && conflict.outcome !== 'restore') {
        continue; // `match`/`skip` mutate no reference entity.
      }
      const perm = REFERENCE_WRITE_PERMISSION[conflict.entity];
      // An unknown reference entity (shouldn't happen with the phase-1 descriptor) is treated as
      // requiring a permission we can't name → fail closed rather than silently skip the check.
      if (!perm) {
        throw new ForbiddenException(
          `Cannot authorize a commit that creates an unknown reference entity (${conflict.entity}).`,
        );
      }
      required.add(perm);
    }

    const actor = await this.prisma.user.findFirst({
      where: { id: actorUserId },
      select: { role: true },
    });
    const allowed =
      actor !== null &&
      (await this.permissions.hasAll(actor.role, [...required]));
    if (!allowed) {
      throw new ForbiddenException(
        'You do not hold all the permissions this import requires. A bulk import needs the write permission for every entity it creates (assets, plus any new models/locations/categories).',
      );
    }
  }

  /**
   * The owner-scoped COMMIT RESULT view (`GET /imports/:id/result`, ADR-0069 wave 4b). Reads the
   * session's status (owner-scoped — 404 for an unknown id or another owner's session, no IDOR) and,
   * once a commit has produced one, its append-only `ImportRun` ledger row (the system of record for
   * counts). `importRunId`/`counts` are null while the commit hasn't finished (the caller polls the
   * session status until COMMITTED). PII-free: only ids + counts.
   */
  async getCommitResult(
    sessionId: string,
    ownerId: string,
  ): Promise<{
    sessionId: string;
    status: string;
    importRunId: number | null;
    counts: {
      total: number;
      valid: number;
      invalid: number;
      committed: number;
      failed: number;
      skipped: number;
    } | null;
  }> {
    const session = await this.prisma.importSession.findFirst({
      where: { id: sessionId, ownerId },
      select: { id: true, status: true },
    });
    if (!session) {
      throw new NotFoundException(`Import session ${sessionId} not found`);
    }
    // The ledger is append-only and written once at the end of a commit; the newest run for this
    // session is the authoritative count. Null until a commit has produced one.
    const run = await this.prisma.importRun.findFirst({
      where: { sessionId },
      orderBy: { id: 'desc' },
      select: { id: true, counts: true },
    });
    const counts = (run?.counts as {
      total: number;
      valid: number;
      invalid: number;
      committed: number;
      failed: number;
      skipped: number;
    } | null) ?? null;
    // The commit ledger records total/committed/failed/skipped; valid/invalid are a dry-run notion.
    // Normalize to the full ImportCounts shape so the wire contract is satisfied (default 0).
    const normalized = run
      ? {
          total: counts?.total ?? 0,
          valid: counts?.valid ?? 0,
          invalid: counts?.invalid ?? 0,
          committed: counts?.committed ?? 0,
          failed: counts?.failed ?? 0,
          skipped: counts?.skipped ?? 0,
        }
      : null;
    return {
      sessionId: session.id,
      status: session.status,
      importRunId: run?.id ?? null,
      counts: normalized,
    };
  }

  /**
   * Commit a DRY_RUN (or resume a COMMITTING) session for `actorUserId`. Loads the frozen plan + the
   * parsed rows (owner-scoped), replays the plan — each asset write suppresses its own per-row search
   * upsert (scoped, not a global mute) — writes per-row `ImportRow` statuses, then the append-only
   * `ImportRun` ledger ONCE with final counts, then runs one search reconcile. Idempotent: a re-run
   * skips COMMITTED rows and detects an already-created asset for a non-COMMITTED row, so a crashed/
   * retried job resumes cleanly with no duplicate asset or ledger (ADR-0069 §8/§9/§10).
   *
   * @param onProgress optional per-chunk callback for `job.updateProgress` (PII-free counts only).
   */
  async commit(
    sessionId: string,
    actorUserId: string,
    onProgress?: (p: { processed: number; total: number }) => void,
  ): Promise<CommitJobResult> {
    const session = await this.prisma.importSession.findFirst({
      where: { id: sessionId, ownerId: actorUserId },
      select: {
        id: true,
        status: true,
        entity: true,
        mapping: true,
        resolutionPlan: true,
        fileHash: true,
        rows: {
          orderBy: { rowIndex: 'asc' },
          select: { id: true, rowIndex: true, status: true, raw: true },
        },
      },
    });
    if (!session) {
      throw new NotFoundException(`Import session ${sessionId} not found`);
    }
    // STATUS-GATED (ADR-0069 §8): commit a freshly-planned session (DRY_RUN) or RESUME an in-flight
    // one (COMMITTING — a BullMQ retry of the same job re-enters here after we flipped the status).
    // A COMMITTED session is rejected so it can never be re-committed into a SECOND ImportRun +
    // duplicate assets; PARSED/MAPPED have no frozen plan; FAILED is terminal (recover via a fresh
    // dry-run). Resume stays safe because per-row COMMITTED rows are skipped below.
    if (session.status !== 'DRY_RUN' && session.status !== 'COMMITTING') {
      throw new ConflictException(
        `Import session ${sessionId} is not committable (status ${session.status}); only a DRY_RUN session can be committed.`,
      );
    }
    if (session.mapping === null) {
      throw new NotFoundException(
        `Import session ${sessionId} has no confirmed mapping`,
      );
    }
    if (session.resolutionPlan === null) {
      throw new NotFoundException(
        `Import session ${sessionId} has no resolution plan (run the dry-run step first)`,
      );
    }

    const mapping = ImportMappingSchema.parse(session.mapping);
    const plan = ImportResolutionPlanSchema.parse(session.resolutionPlan);
    const resolutions = this.indexPlan(plan);

    await this.prisma.importSession.update({
      where: { id: session.id },
      data: { status: 'COMMITTING' },
    });

    // The actor we attribute every write to — a minimal human principal carrying the loaded User so
    // the actor service resolves `{ userId }` (import is human-only, ADMIN — ADR-0069 §11).
    const user = await this.prisma.user.findFirst({ where: { id: actorUserId } });
    const principal: Principal | undefined = user
      ? { kind: 'human', user }
      : undefined;

    // Memo: a distinct reference value is created/restored/found AT MOST ONCE across the whole commit,
    // keyed exactly like the resolution index so the same value never spawns two rows.
    const refIdMemo = new Map<string, string | null>();
    // Negative memo: a reference whose create-outcome DOOMED (e.g. threw) is recorded so a doomed ref
    // is attempted ONCE — not re-tried per dependent row. A dependent row still fails (the operator
    // chose to create that ref), it just doesn't re-hit the DB. Keyed like `refIdMemo`.
    const failedRefs = new Set<string>();

    let committed = 0;
    let failed = 0;
    // `skipped` is part of the counts contract (a row-level skip), but phase-1 plans only express a
    // reference-level skip (drop the FK, keep the row) — there is no operator "skip these N rows"
    // outcome yet, so this stays 0. Kept for the ImportCounts shape + a future wave.
    const skipped = 0;
    const total = session.rows.length;
    let processed = 0;

    // Per-row Meili upserts are suppressed at the SOURCE — each `create()` is passed
    // `suppressSearch: true` (no process-wide counter; a concurrent non-import write is never dropped).
    // ONE `reconcileSearch()` runs after the loop instead (ADR-0069 §10).
    for (const row of session.rows) {
      // RESUMABLE: a re-run never re-creates a row that already committed (ADR-0069 §8).
      if (row.status === 'COMMITTED') {
        committed += 1;
        processed += 1;
        continue;
      }

      const outcome = await this.commitRow(
        row,
        session.id,
        mapping,
        resolutions,
        refIdMemo,
        failedRefs,
        principal,
      );
      if (outcome.kind === 'committed') committed += 1;
      else failed += 1;

      processed += 1;
      if (processed % COMMIT_CHUNK_SIZE === 0) {
        onProgress?.({ processed, total });
      }
    }

    onProgress?.({ processed, total });

    // APPEND-ONLY ledger (ADR-0006): the `ImportRun` is written ONCE, after the loop, with FINAL
    // counts — never inserted-zeroed-then-updated. If the worker throws mid-batch the row is simply
    // never written (the per-row statuses + the COMMITTED-row resume are the durable record), so the
    // ledger is never left with misleading stale counts. Asset→import correlation rides the CREATED
    // event's `sessionId` provenance, which is known upfront (not this autoincrement id).
    const run = await this.prisma.importRun.create({
      data: {
        sessionId: session.id,
        entity: session.entity,
        actorId: actorUserId,
        fileHash: session.fileHash,
        counts: { total, committed, failed, skipped },
        conflictSummary: this.summarizePlan(plan),
      },
      select: { id: true },
    });

    await this.prisma.importSession.update({
      where: { id: session.id },
      data: { status: 'COMMITTED' },
    });

    // ONE search reconcile after the bulk (ADR-0069 §10): rebuild the assets index from the live set so
    // every just-imported asset is searchable without the per-row upsert storm. Fail-soft (no-op when
    // Meili is disabled); a reconcile failure never fails the (already-durable) import.
    await this.reconcileSearch();

    return {
      sessionId: session.id,
      importRunId: run.id,
      committed,
      failed,
      skipped,
    };
  }

  // ===== Per-row replay ========================================================================

  /**
   * Commit ONE row: detect a prior partial write (resume) → coerce → resolve its FK refs from the plan
   * (match/restore/create-memoized/skip) → re-validate the assembled payload → `AssetsService.create()`
   * with import provenance. Records the `ImportRow` status (COMMITTED/FAILED) and NEVER throws on a
   * domain failure — a per-row `P2002`/`P2003`/validation error is isolated so the batch continues
   * (ADR-0069 §8 keep-partial).
   *
   * DUAL-WRITE SAFETY (ADR-0069 §8): `create()` then `markRow('COMMITTED')` are two writes; if create()
   * lands but markRow throws, the row stays non-COMMITTED, and a resume would re-create the asset
   * (duplicate). So BEFORE re-creating a non-COMMITTED row we probe the CREATED-event provenance for an
   * asset already created for `(sessionId, rowIndex)`; if found, we reconcile the row to COMMITTED
   * instead of re-creating it. Idempotent across the `attempts:3` retry budget.
   */
  private async commitRow(
    row: { id: number; rowIndex: number; raw: Prisma.JsonValue },
    sessionId: string,
    mapping: ImportMapping,
    resolutions: Map<string, ConflictResolution>,
    refIdMemo: Map<string, string | null>,
    failedRefs: Set<string>,
    principal: Principal | undefined,
  ): Promise<{ kind: 'committed' | 'failed' }> {
    try {
      // Resume-detect: was an asset already created for this row in a prior (crashed) attempt? If so,
      // reconcile the row to COMMITTED rather than minting a duplicate. ponytail: one extra lookup per
      // non-COMMITTED row; a later wave could gate it behind an explicit `isResume` flag if it shows up
      // in commit latency, but at concurrency-1 chunked commits it is negligible and unconditionally
      // correct.
      if (await this.assetExistsForRow(sessionId, row.rowIndex)) {
        await this.markRow(row.id, 'COMMITTED', null);
        return { kind: 'committed' };
      }

      const raw = row.raw as Record<string, string>;
      const { payload, references, specs } = coerceRow(
        raw,
        mapping,
        IMPORT_DESCRIPTORS.asset,
      );

      // The brand/category for a Model this row may create (ADR-0069 REDESIGN §4.4) — resolved from the
      // mapping's modelConfig + this row's cells, carried into createReference (used only on a `create`).
      const modelCreateConfig = modelCreateConfigFor(mapping.modelConfig, raw);

      // Resolve every declared FK reference against the frozen plan. A `skip` cascade drops the link
      // (import without it); a row whose reference must be created mints the ref once (memoized).
      const refMap = assetImportDescriptor.references as Record<
        string,
        { entity: string } | undefined
      >;
      for (const [field, value] of Object.entries(references)) {
        const ref = refMap[field];
        if (!ref) continue;
        const normalizedValue = normalizeMatchKey(value);
        const resolved = await this.resolveReference(
          ref.entity,
          field,
          normalizedValue,
          resolutions,
          refIdMemo,
          failedRefs,
          principal,
          modelCreateConfig,
        );
        if (resolved === null) continue; // skip cascade: omit the FK, keep the row.
        payload[field] = resolved;
      }

      // Custom fields → Asset.specs (ADR-0069 REDESIGN §4.3): coerceRow already built `specs` null-proto
      // (omit-empty, never `{}`, reserved keys skipped). Re-build it null-proto + re-guard reserved keys
      // AT THE WRITE SITE (defense-in-depth) so a corrupt/malicious persisted mapping that somehow reached
      // here can't pollute the prototype. The strict CreateAssetSchema (`specs: record(string,unknown)`)
      // still revalidates it below — a custom key colliding with a native top-level field was already
      // rejected by the mapping superRefine.
      if (specs !== undefined) {
        payload.specs = sanitizeSpecs(specs);
      }

      // RE-VALIDATE against the unchanged strict schema (estate may have drifted; validating BEFORE
      // create() guarantees a doomed row never burns an asset-tag counter number — ADR-0069 §7).
      const parsed = CreateAssetSchema.safeParse(payload);
      if (!parsed.success) {
        await this.markRow(row.id, 'FAILED', {
          phase: 'commit',
          reason: 'validation',
          fields: parsed.error.issues.map((i) => ({
            field: i.path.length > 0 ? String(i.path[0]) : null,
            message: i.message,
          })),
        });
        return { kind: 'failed' };
      }

      await this.assets.create(parsed.data as CreateAsset, principal, {
        // Stamp the STABLE sessionId (known upfront) + rowIndex — not the autoincrement ImportRun id,
        // which doesn't exist until after the loop (ADR-0069 §8/§9). This is the provenance the resume
        // probe matches on, and the asset→import correlation key (via ImportRun.sessionId).
        createdPayload: { source: 'import', sessionId, rowIndex: row.rowIndex },
        // Per-row search upsert is suppressed (ADR-0069 §10) — one reconcile runs after the bulk. This
        // is SCOPED to the import's own asset writes, not a process-wide mute.
        suppressSearch: true,
      });
      await this.markRow(row.id, 'COMMITTED', null);
      return { kind: 'committed' };
    } catch (err) {
      // Per-row isolation (ADR-0069 §8): a unique/FK collision since preview, or any create-path error,
      // is recorded as a FAILED row — the batch is NEVER aborted. PII-free reason (a code, not data).
      await this.markRow(row.id, 'FAILED', {
        phase: 'commit',
        reason: this.failureReason(err),
      });
      return { kind: 'failed' };
    }
  }

  /**
   * Resolve one FK reference to a concrete id (or null = skip-the-link) by replaying the plan:
   *   - match   → the resolved live `targetId`.
   *   - restore → restore the soft-deleted `targetId` (idempotent) and use it.
   *   - create  → find-or-create the reference entity ONCE (memoized) from its natural-key value.
   *   - skip    → null (the caller omits the FK; the row is imported without the link).
   * No resolution for a value (the operator didn't surface it) defaults to skip-the-link — never a
   * silent wrong FK. Memoized by the resolution key so a value is created/restored at most once; a
   * DOOMED create is negative-memoized so it is attempted once and every dependent row fails fast
   * (re-throwing the original error) without re-hitting the DB (ADR-0069 §9).
   */
  private async resolveReference(
    entity: string,
    field: string,
    normalizedValue: string,
    resolutions: Map<string, ConflictResolution>,
    refIdMemo: Map<string, string | null>,
    failedRefs: Set<string>,
    principal: Principal | undefined,
    modelCreateConfig: ModelCreateConfig = {},
  ): Promise<string | null> {
    const key = resolutionKey(entity, field, normalizedValue);
    if (refIdMemo.has(key)) return refIdMemo.get(key)!;
    // Negative memo: this ref already failed to create once — fail the dependent row WITHOUT another
    // DB round-trip (the operator chose to create it, so the row can't silently import without the FK).
    if (failedRefs.has(key)) {
      throw new ReferenceCreateFailedError(entity, field);
    }

    const resolution = resolutions.get(key);
    if (!resolution || resolution.outcome === 'skip') {
      refIdMemo.set(key, null);
      return null;
    }

    let id: string | null = null;
    if (resolution.outcome === 'match') {
      id = resolution.targetId;
    } else if (resolution.outcome === 'restore') {
      id = resolution.targetId
        ? await this.restoreReference(entity, resolution.targetId)
        : null;
    } else if (resolution.outcome === 'create') {
      try {
        id = await this.createReference(
          entity,
          normalizedValue,
          principal,
          modelCreateConfig,
        );
      } catch (err) {
        // Doomed create: remember it so the next dependent row fails fast, then propagate so THIS row
        // is recorded FAILED with a PII-free reason by commitRow's catch.
        failedRefs.add(key);
        throw err;
      }
    }
    refIdMemo.set(key, id);
    return id;
  }

  /** Restore a soft-deleted reference row (idempotent) and return its id. */
  private async restoreReference(
    entity: string,
    targetId: string,
  ): Promise<string> {
    if (entity === 'AssetModel') {
      const m = await this.models.restore(targetId);
      return m.id;
    }
    if (entity === 'Location') {
      const l = await this.locations.restore(targetId);
      return l.id;
    }
    return targetId;
  }

  /**
   * FIND-OR-CREATE a reference entity by its natural-key value (ADR-0069 §9 idempotency). The commit
   * job has `attempts:3`, so a `create`-outcome reference minted in run 1 would be RE-CREATED on a
   * resumed/retried run — a duplicate (Location/AssetModel `name` is not unique, so no P2002 stops it;
   * and for an AssetModel with a `sku`, a P2002 would then fail every dependent row). So we LOOK UP the
   * live row by natural key first and reuse it if present; only when absent do we create. Idempotent
   * across retries. The in-memory `refIdMemo` collapses repeats within ONE run; this find-first closes
   * the ACROSS-run window.
   *
   * Required fields the value can't supply get an audit-honest phase-1 default the operator can edit
   * later — never a silent drop. An `AssetModel` create now reads its REAL manufacturer + category from
   * the row's `modelCreateConfig` (ADR-0069 REDESIGN §4.4): manufacturer falls back to `'Unknown'` only
   * as a last resort; a category NAME is resolved to a `categoryId` via the SAME idempotent find-first
   * pattern (find-or-create `AssetCategory` by name) so a concurrent/retried run reuses it instead of
   * minting a duplicate.
   *
   * ponytail: brand/category are two flat fields from the mapping's modelConfig, not a generic
   * sub-descriptor. Ceiling: the create's richer per-reference fields still aren't captured by the
   * dry-run's `create` outcome (only model brand/category are). Upgrade path: thread a richer per-
   * reference field bag through the resolution plan and pass it here.
   */
  private async createReference(
    entity: string,
    normalizedValue: string,
    principal: Principal | undefined,
    modelCreateConfig: ModelCreateConfig = {},
  ): Promise<string> {
    if (entity === 'Location') {
      const found = await this.prisma.location.findFirst({
        where: { name: normalizedValue },
        select: { id: true },
      });
      if (found) return found.id;
      const l = await this.locations.create({
        name: normalizedValue,
        type: IMPORT_LOCATION_DEFAULT_TYPE,
      });
      return l.id;
    }
    if (entity === 'AssetModel') {
      const found = await this.prisma.assetModel.findFirst({
        where: { name: normalizedValue },
        select: { id: true },
      });
      if (found) return found.id;
      // Resolve the category NAME → id first (find-or-create). CreateAssetModelSchema takes
      // `categoryId: z.cuid()`, NOT a name, so the name→id resolution is mandatory (REDESIGN §4.4).
      const categoryId = modelCreateConfig.categoryName
        ? await this.findOrCreateCategory(modelCreateConfig.categoryName)
        : undefined;
      // Run the SAME strict schema the HTTP path uses BEFORE the service create, so an import-created
      // model honors the same caps (`name`/`manufacturer` `.max(200)`) — a long manufacturer cell can't
      // bypass them via the import seam. A cap violation throws here and is recorded as a FAILED row.
      const m = await this.models.create(
        CreateAssetModelSchema.parse({
          name: normalizedValue,
          manufacturer:
            modelCreateConfig.manufacturer ?? IMPORT_MODEL_DEFAULT_MANUFACTURER,
          ...(categoryId !== undefined ? { categoryId } : {}),
        }),
      );
      return m.id;
    }
    // Unknown phase-1 entity — should never happen with the asset descriptor.
    throw new Error(`Cannot create reference for unknown entity ${entity}`);
  }

  /**
   * FIND-OR-CREATE an `AssetCategory` by name → id (ADR-0069 REDESIGN §4.4). Same idempotent find-first
   * pattern as Model/Location: a live category with this name is reused; only when absent do we create.
   * The in-memory `refIdMemo` doesn't cover categories (they're resolved THROUGH the model, not a plan
   * conflict), so this find-first is what closes the cross-run/within-run duplicate window — a 200-row
   * import that all maps to the "Laptop" category creates it ONCE. `AssetCategory.name` is uniquely
   * indexed on the LIVE set, so the find-first matches a live ghost-free row; a soft-deleted ghost of
   * the same name isn't seen (a new live one is created — the accepted ghost edge, same as Model).
   */
  private async findOrCreateCategory(name: string): Promise<string> {
    const trimmed = name.trim();
    const found = await this.prisma.assetCategory.findFirst({
      where: { name: trimmed },
      select: { id: true },
    });
    if (found) return found.id;
    // Same strict schema as the HTTP path so an import-created category honors `name` `.max(100)` (a
    // long category cell can't bypass the cap via the import seam). A violation throws → FAILED row.
    const created = await this.categories.create(
      CreateAssetCategorySchema.parse({ name: trimmed }),
    );
    return created.id;
  }

  // ===== Helpers ===============================================================================

  /** Index the frozen plan by `(entity, field, normalizedValue)` for O(1) per-reference replay. */
  private indexPlan(plan: ImportResolutionPlan): Map<string, ConflictResolution> {
    const map = new Map<string, ConflictResolution>();
    for (const c of plan.conflicts) {
      map.set(resolutionKey(c.entity, c.field, c.normalizedValue), c);
    }
    return map;
  }

  /** PII-free conflict summary for the ledger: outcome counts, never the source values. */
  private summarizePlan(plan: ImportResolutionPlan): {
    match: number;
    restore: number;
    create: number;
    skip: number;
  } {
    const summary = { match: 0, restore: 0, create: 0, skip: 0 };
    for (const c of plan.conflicts) summary[c.outcome] += 1;
    return summary;
  }

  /**
   * Resume-detect (ADR-0069 §8): has an asset already been created for this `(sessionId, rowIndex)`?
   * Looks for a `CREATED` `AssetHistory` event whose import provenance payload matches both keys (a jsonb
   * path filter per key, AND-ed). Returns true iff a prior attempt created the asset but its `markRow`
   * never landed — so the caller reconciles the row instead of minting a duplicate. False on any other
   * row, so the happy path is unaffected.
   */
  private async assetExistsForRow(
    sessionId: string,
    rowIndex: number,
  ): Promise<boolean> {
    const existing = await this.prisma.assetHistory.findFirst({
      where: {
        eventType: 'CREATED',
        AND: [
          { payload: { path: ['source'], equals: 'import' } },
          { payload: { path: ['sessionId'], equals: sessionId } },
          { payload: { path: ['rowIndex'], equals: rowIndex } },
        ],
      },
      select: { id: true },
    });
    return existing !== null;
  }

  /** Classify a caught error into a PII-free reason code for the row's recorded failure. */
  private failureReason(err: unknown): string {
    if (err instanceof ReferenceCreateFailedError) return 'reference-create-failed';
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002') return 'unique-taken-since-preview';
      if (err.code === 'P2003') return 'reference-missing-since-preview';
      return `prisma-${err.code}`;
    }
    return 'create-failed';
  }

  /**
   * Record a per-row outcome (PII-free error blob). The created asset's id is NOT stashed on the row —
   * the `coerced` column holds the parse-time payload and must not be clobbered; the row-keyed result
   * report (with `entityId`) is wave 4b, and a committed asset is already correlatable via its CREATED
   * event provenance + the `ImportRun` ledger.
   */
  private async markRow(
    rowId: number,
    status: 'COMMITTED' | 'FAILED' | 'SKIPPED',
    error: Prisma.InputJsonValue | null,
  ): Promise<void> {
    await this.prisma.importRow.update({
      where: { id: rowId },
      data: {
        status,
        ...(error !== null ? { error } : {}),
      },
    });
  }

  /**
   * The single post-import search reconcile (ADR-0069 §10). Rebuilds the `assets` index from the live
   * set so every imported asset is searchable without the per-row upsert storm. No-op when Meili is
   * disabled; a reconcile failure is swallowed (the import is already durable in Postgres).
   */
  private async reconcileSearch(): Promise<void> {
    if (!this.search.enabled) return;
    try {
      // The soft-delete Prisma client extension (ADR-0006/0032) scopes this `findMany` to LIVE rows
      // (`deletedAt IS NULL`), so the rebuilt index never resurrects a soft-deleted asset.
      const assets = await this.prisma.asset.findMany();
      await this.search.rebuildIndex(
        'assets',
        assets.map((a) => projectAsset(a)),
      );
    } catch {
      // Fail-soft: the import committed; a stale index self-heals on the next write or a `reindex:all`.
    }
  }
}
