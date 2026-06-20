import { Injectable, NotFoundException } from '@nestjs/common';
import {
  assetImportDescriptor,
  coerceRow,
  IMPORT_DESCRIPTORS,
  CreateAssetSchema,
  CreateDirectoryPersonSchema,
  normalizeMatchKey,
  type AssetTagDecision,
  type ConflictCandidate,
  type ConflictOutcome,
  type ImportDryRunReport,
  type ImportMapping,
  type ImportResolutionPlan,
  type ReferenceConflict,
  type RowFieldError,
  type RowResult,
} from '@lazyit/shared';
import { ImportMappingSchema } from '@lazyit/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The migrator DRY-RUN ENGINE (ADR-0069 §3–§7, wave 3, #631) — the brain. Given a PARSED/MAPPED
 * session, it runs the FULL preview pipeline — coerce → validate (`CreateAssetSchema.safeParse`) →
 * resolve FK references by natural key → detect conflicts → classify asset tags — and produces the
 * dry-run report the operator resolves. It is **READ-ONLY on domain data**: it probes existing
 * Asset/AssetModel/Location/AssetCategory rows (with the `includeSoftDeleted` escape hatch so ghosts
 * surface as `restore` candidates) but writes ZERO domain rows. The one and only write it makes is
 * persisting the operator's resolution plan into the session's OWN transient state (its `resolutionPlan`
 * jsonb) — scratch, not domain data. The chunked COMMIT worker (which replays the plan and actually
 * creates rows) is wave 4 — out of scope here.
 *
 * SECURITY: every session read is OWNER-SCOPED (no IDOR — ADR-0069 §11); logs stay PII-free.
 */

/** The resolution probe for one entity (cached per distinct natural-key value). */
interface ResolveResult {
  candidates: ConflictCandidate[];
}

@Injectable()
export class ImportDryRunService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Run the dry-run for an owner's session and return the report. Reads the session's MAPPED state +
   * its parsed rows (owner-scoped), runs the pipeline writing nothing, and returns per-row outcomes,
   * the deduped conflict set and the per-row tag decisions. Does NOT persist a plan — the operator
   * resolves the surfaced conflicts and calls {@link saveResolutionPlan} (the only domain-adjacent
   * write, and it is the session's own scratch).
   */
  async dryRun(
    sessionId: string,
    ownerId: string,
  ): Promise<ImportDryRunReport> {
    const session = await this.prisma.importSession.findFirst({
      where: { id: sessionId, ownerId },
      select: {
        id: true,
        mapping: true,
        rows: {
          orderBy: { rowIndex: 'asc' },
          select: { rowIndex: true, raw: true },
        },
      },
    });
    if (!session) {
      throw new NotFoundException(`Import session ${sessionId} not found`);
    }
    if (session.mapping === null) {
      throw new NotFoundException(
        `Import session ${sessionId} has no confirmed mapping (run the map step first)`,
      );
    }
    const mapping = ImportMappingSchema.parse(session.mapping);
    const rows = session.rows.map((r) => ({
      rowIndex: r.rowIndex,
      raw: r.raw as Record<string, string>,
    }));

    // NOTE (ADR-0069 REDESIGN §4.4 / §5.2): the created-model brand + category live on
    // `mapping.modelConfig` (the corrected design — they do NOT travel through the resolution plan / a
    // ConflictResolution). The mapping is persisted whole on the session, so `modelConfig` reaches the
    // commit's `createReference` directly via the loaded mapping; the dry-run neither resolves nor
    // creates an `AssetCategory` here (the dry-run is READ-ONLY on domain data — a category is
    // find-or-created idempotently at COMMIT, never in the preview). No plan/preview shape change.
    return this.analyze(rows, mapping);
  }

  /**
   * The pure-ish analysis core (exposed for fixtures/unit tests): coerce + validate + resolve +
   * conflict-detect + tag-classify a set of raw rows under a mapping, writing nothing. The only IO is
   * the read-only resolution probes against existing rows.
   */
  async analyze(
    rows: { rowIndex: number; raw: Record<string, string> }[],
    mapping: ImportMapping,
  ): Promise<ImportDryRunReport> {
    // 1. Coerce + validate every row; collect the distinct reference values to resolve.
    const rowResults: RowResult[] = [];
    // perRow: the coerced FK references, kept to compute the per-conflict blast radius.
    const perRowRefs: { rowIndex: number; references: Record<string, string> }[] =
      [];
    const tagDecisions: AssetTagDecision[] = [];

    // distinct (entity, field, normalizedValue) → set of affected row indexes.
    const conflictRows = new Map<string, Set<number>>();
    // remember the (entity, field, value) tuple for each key so we can rebuild it.
    const conflictMeta = new Map<
      string,
      { entity: string; field: string; normalizedValue: string }
    >();

    for (const { rowIndex, raw } of rows) {
      // Per-row isolation (mirrors `commitRow`'s catch): `coerceRow` is pure but a malformed/hostile
      // mapping or cell could still throw — and one bad row must NEVER 500 the whole preview. Record it
      // as an invalid row and move on (the operator fixes it), exactly like the commit's keep-partial.
      let coerced: ReturnType<typeof coerceRow>;
      try {
        coerced = coerceRow(raw, mapping, IMPORT_DESCRIPTORS.asset);
      } catch {
        rowResults.push({
          rowIndex,
          status: 'invalid',
          errors: [{ field: null, message: 'This row could not be processed.' }],
          entityId: null,
        });
        // Still emit a tag decision so the per-row arrays stay index-aligned with rowResults.
        tagDecisions.push({ rowIndex, mode: 'none', tag: null, collision: false });
        continue;
      }
      const { payload, references, enumMisses } = coerced;

      const errors: RowFieldError[] = enumMisses.map((m) => ({
        field: m.field,
        message: `Value "${m.value}" is not a recognized ${m.field}`,
      }));

      const parsed = CreateAssetSchema.safeParse(payload);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          errors.push({
            field: issue.path.length > 0 ? String(issue.path[0]) : null,
            message: issue.message,
          });
        }
      }

      // Validate the directory-person bucket too (fix #647). The commit creates a User from it via
      // CreateDirectoryPersonSchema, but the dry-run previously validated ONLY the asset — so a person
      // with an identity key (email/legajo/username) but no `name` passed preview, then FAILED every
      // row at commit and orphaned the asset. Surface those issues HERE so the operator fixes them first.
      if (coerced.person !== undefined) {
        const personParsed = CreateDirectoryPersonSchema.safeParse(coerced.person);
        if (!personParsed.success) {
          for (const issue of personParsed.error.issues) {
            errors.push({
              field: issue.path.length > 0 ? `person.${String(issue.path[0])}` : "person",
              message: issue.message,
            });
          }
        }
      }

      rowResults.push({
        rowIndex,
        status: errors.length > 0 ? 'invalid' : 'valid',
        errors,
        entityId: null,
      });

      // Record references for VALID rows only — an invalid row is not going to be created, so its FK
      // values shouldn't inflate a conflict's blast radius (the operator fixes the row first).
      if (errors.length === 0) {
        perRowRefs.push({ rowIndex, references });
        const refMap = assetImportDescriptor.references as Record<
          string,
          { entity: string; matchBy: readonly string[] } | undefined
        >;
        for (const [field, value] of Object.entries(references)) {
          const ref = refMap[field];
          if (!ref) continue;
          const normalizedValue = normalizeMatchKey(value);
          const key = `${ref.entity}\u0000${field}\u0000${normalizedValue}`;
          conflictMeta.set(key, {
            entity: ref.entity,
            field,
            normalizedValue,
          });
          (conflictRows.get(key) ?? conflictRows.set(key, new Set()).get(key)!).add(
            rowIndex,
          );
        }
      }

      // Asset-tag classification (decision only) — needs the payload's tag + whether the row matches
      // an existing asset by serial. Computed after resolution below; stash the payload tag here.
      tagDecisions.push(this.classifyTagPlaceholder(rowIndex, payload));
    }

    // 2. Resolve each DISTINCT reference value ONCE (cached) → candidates.
    const resolveCache = new Map<string, ResolveResult>();
    const conflicts: ReferenceConflict[] = [];
    for (const [key, meta] of conflictMeta) {
      const resolved = await this.resolveCached(
        resolveCache,
        meta.entity,
        meta.normalizedValue,
      );
      const affected = [...(conflictRows.get(key) ?? [])].sort((a, b) => a - b);
      const { suggested, ambiguous } = this.classifyConflict(
        resolved.candidates,
      );
      conflicts.push({
        entity: meta.entity,
        field: meta.field,
        normalizedValue: meta.normalizedValue,
        rowCount: affected.length,
        sampleRowIndexes: affected.slice(0, 5),
        candidates: resolved.candidates,
        suggested,
        ambiguous,
      });
    }

    // 3. Finalize asset-tag decisions: an explicit tag that collides with a LIVE asset is a per-row
    // conflict (never silently dropped — ADR-0069 §7 / ADR-0068 §1).
    const finalTags = await this.finalizeTags(tagDecisions, perRowRefs);

    // 4. Counts.
    const valid = rowResults.filter((r) => r.status === 'valid').length;
    const invalid = rowResults.length - valid;

    return {
      result: {
        counts: {
          total: rowResults.length,
          valid,
          invalid,
          committed: 0,
          failed: 0,
          skipped: 0,
        },
        rows: rowResults,
      },
      // Stable, deterministic order for the UI / snapshot tests.
      conflicts: conflicts.sort(
        (a, b) =>
          a.entity.localeCompare(b.entity) ||
          a.field.localeCompare(b.field) ||
          a.normalizedValue.localeCompare(b.normalizedValue),
      ),
      tags: finalTags,
    };
  }

  /**
   * Persist the operator's resolution plan into the session's OWN transient state (its `resolutionPlan`
   * jsonb). This is the ONLY write the dry-run wave makes — session scratch, never domain data — and it
   * advances the session to DRY_RUN. Owner-scoped (no IDOR). The plan is validated against the wave-1
   * `ImportResolutionPlanSchema` at the controller boundary (wave 4); here we store the already-typed plan.
   */
  async saveResolutionPlan(
    sessionId: string,
    ownerId: string,
    plan: ImportResolutionPlan,
  ): Promise<void> {
    const updated = await this.prisma.importSession.updateMany({
      where: { id: sessionId, ownerId },
      data: { resolutionPlan: plan as object, status: 'DRY_RUN' },
    });
    if (updated.count === 0) {
      throw new NotFoundException(`Import session ${sessionId} not found`);
    }
  }

  // ===== Reference resolution (cached, dependency-ordered, includeSoftDeleted) =================

  /** Resolve a distinct natural-key value once, memoized by `(entity, normalizedValue)`. */
  private async resolveCached(
    cache: Map<string, ResolveResult>,
    entity: string,
    normalizedValue: string,
  ): Promise<ResolveResult> {
    const cacheKey = `${entity}\u0000${normalizedValue}`;
    const hit = cache.get(cacheKey);
    if (hit) return hit;
    const result = await this.resolve(entity, normalizedValue);
    cache.set(cacheKey, result);
    return result;
  }

  /** Dispatch resolution by entity. Phase 1: AssetModel + Location (category rides the model). */
  private async resolve(
    entity: string,
    normalizedValue: string,
  ): Promise<ResolveResult> {
    if (entity === 'AssetModel') return this.resolveModel(normalizedValue);
    if (entity === 'Location') return this.resolveLocation(normalizedValue);
    // Unknown entity (shouldn't happen with the phase-1 descriptor) → no candidates ⇒ create.
    return { candidates: [] };
  }

  /**
   * AssetModel: `sku` EXACT (case-sensitive) first, else a soft case-folded `name` match (names aren't
   * unique → candidates, NEVER auto-pick). Probes WITH soft-deleted so ghosts surface as `restore`.
   * Category is resolved THROUGH the model (the asset has no direct category — descriptor note), so each
   * candidate carries its `categoryName`.
   */
  private async resolveModel(normalizedValue: string): Promise<ResolveResult> {
    const rows = await this.prisma.assetModel.findMany({
      where: {
        OR: [
          { sku: normalizedValue },
          { name: { equals: normalizedValue, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        name: true,
        manufacturer: true,
        sku: true,
        deletedAt: true,
        category: { select: { name: true } },
      },
      // includeSoftDeleted: probe ghosts too (restore path — ADR-0069 §5/§6). The escape-hatch arg
      // isn't in the generated args type (it's stripped by the soft-delete extension), so we widen the
      // args object — the literal `select` still narrows the result (the established pattern).
      ...({ includeSoftDeleted: true } as object),
    });

    // An exact-sku hit is the strongest signal; if any live exact-sku match exists, prefer ONLY those
    // as candidates (the soft (manufacturer,name) match is a fallback, not an addition, when sku hits).
    const skuExact = rows.filter((r) => r.sku === normalizedValue);
    const pool = skuExact.length > 0 ? skuExact : rows;

    const candidates: ConflictCandidate[] = pool.map((r) => ({
      id: r.id,
      label: r.sku
        ? `${r.manufacturer} ${r.name} (${r.sku})`
        : `${r.manufacturer} ${r.name}`,
      live: r.deletedAt === null,
      categoryName: r.category?.name ?? null,
    }));
    return { candidates: this.preferLive(candidates) };
  }

  /**
   * Location: by normalized name — EXACT after trim (ADR-0069 §5: per-key normalization is trim-only,
   * NOT case-folded, mirroring how the name is actually stored + uniquely indexed). Probes WITH
   * soft-deleted so a ghost location surfaces as a `restore` candidate.
   */
  private async resolveLocation(
    normalizedValue: string,
  ): Promise<ResolveResult> {
    const rows = await this.prisma.location.findMany({
      where: { name: normalizedValue },
      select: { id: true, name: true, deletedAt: true },
      ...({ includeSoftDeleted: true } as object),
    });
    const candidates: ConflictCandidate[] = rows.map((r) => ({
      id: r.id,
      label: r.name,
      live: r.deletedAt === null,
      categoryName: null,
    }));
    return { candidates: this.preferLive(candidates) };
  }

  /**
   * When a value resolves to BOTH live and ghost rows, the live ones are the relevant matches (a ghost
   * with the same natural key only matters when no live row holds it — the partial-unique index frees a
   * ghost's key). So: if any live candidate exists, drop the ghosts; otherwise keep the ghosts (restore).
   */
  private preferLive(candidates: ConflictCandidate[]): ConflictCandidate[] {
    const live = candidates.filter((c) => c.live);
    return live.length > 0 ? live : candidates;
  }

  /**
   * The four-outcome classification (ADR-0069 §6): exactly one LIVE candidate ⇒ `match`; only
   * ghost(s) ⇒ `restore`; none ⇒ `create`. On AMBIGUITY (>1 candidate) the engine surfaces them and
   * sets `ambiguous` — the operator MUST pick (no auto-pick on N candidates). `skip` is an
   * operator-only choice, never the engine's suggestion.
   */
  private classifyConflict(candidates: ConflictCandidate[]): {
    suggested: ConflictOutcome;
    ambiguous: boolean;
  } {
    if (candidates.length === 0) return { suggested: 'create', ambiguous: false };
    if (candidates.length > 1) {
      // Ambiguous — suggest the safest non-destructive default (match a live one if all are live,
      // else restore), but flag it so the UI forces an explicit choice.
      const allLive = candidates.every((c) => c.live);
      return { suggested: allLive ? 'match' : 'restore', ambiguous: true };
    }
    const only = candidates[0];
    return { suggested: only.live ? 'match' : 'restore', ambiguous: false };
  }

  // ===== Asset-tag classification (decision only — no allocation) ==============================

  /**
   * First-pass tag decision from the coerced payload alone: an explicit `assetTag` ⇒ `explicit`;
   * otherwise provisional `none` (upgraded to `auto-mint` in {@link finalizeTags} if the scheme is on,
   * or to `use-existing` if the row matches an existing asset). Collision is resolved in finalize.
   */
  private classifyTagPlaceholder(
    rowIndex: number,
    payload: Record<string, unknown>,
  ): AssetTagDecision {
    const tag = typeof payload.assetTag === 'string' ? payload.assetTag : null;
    return {
      rowIndex,
      mode: tag !== null ? 'explicit' : 'none',
      tag,
      collision: false,
    };
  }

  /**
   * Finalize tag decisions (ADR-0069 §7 / ADR-0068 §1): for an EXPLICIT tag, flag a collision when it
   * already exists on a LIVE asset (surfaced as a per-row conflict, never silently dropped). For a
   * tagless row, upgrade to `auto-mint` when the scheme is ENABLED (the commit worker allocates — no
   * allocation here), else leave `none`.
   *
   * ponytail: the `use-existing` mode (keep the matched asset's tag) is in the wire schema but NOT
   * emitted here. Ceiling: it needs the row→existing-asset match, which keys off `serial` — and the
   * asset's natural-key match path is itself a wave-4 commit concern (the dry-run resolves FK refs, not
   * the asset-by-serial dedupe). Phase-1 dry-run classifies create-path tags only. Upgrade path: when
   * wave 4 adds serial-dedupe, set `use-existing` for a row that matched an existing live asset.
   * `_perRowRefs` is threaded through for that future blast-radius work (unused now).
   */
  private async finalizeTags(
    decisions: AssetTagDecision[],
    _perRowRefs: { rowIndex: number; references: Record<string, string> }[],
  ): Promise<AssetTagDecision[]> {
    const explicitTags = decisions
      .filter((d) => d.mode === 'explicit' && d.tag !== null)
      .map((d) => d.tag as string);

    // One probe for all explicit tags: which collide with a LIVE asset tag.
    const liveTagSet = new Set<string>();
    if (explicitTags.length > 0) {
      const live = await this.prisma.asset.findMany({
        where: { assetTag: { in: explicitTags } },
        select: { assetTag: true },
        // default filter (deletedAt: null) applies — a ghost tag is free to reuse, so NOT a collision.
      });
      for (const a of live) if (a.assetTag) liveTagSet.add(a.assetTag);
    }

    // Is the org-wide asset-tag scheme enabled? (single-row, opt-in — ADR-0063.)
    const scheme = await this.prisma.assetTagScheme.findFirst({
      where: { id: 'singleton' },
      select: { enabled: true },
    });
    const schemeEnabled = scheme?.enabled === true;

    return decisions.map((d) => {
      if (d.mode === 'explicit' && d.tag !== null) {
        return { ...d, collision: liveTagSet.has(d.tag) };
      }
      if (d.mode === 'none' && schemeEnabled) {
        return { ...d, mode: 'auto-mint' as const };
      }
      return d;
    });
  }
}
