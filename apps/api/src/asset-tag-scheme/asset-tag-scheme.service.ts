import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  AssetTagBackfillApply,
  AssetTagBackfillItem,
  AssetTagBackfillMode,
  AssetTagBackfillPreview,
  AssetTagBackfillPreviewQuery,
  AssetTagBackfillResult,
  AssetTagScheme,
  AssetTagSeedSuggestion,
  AssetTagSeedSuggestionQuery,
  UpdateAssetTagScheme,
} from '@lazyit/shared';
import {
  INT4_MAX,
  parseAssetTagNumber,
  renderAssetTag,
} from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  AssetHistoryService,
  type RecordAssetEvent,
} from '../asset-history/asset-history.service';
import { ActorService } from '../common/actor.service';
import type { Principal } from '../auth/principal';

/**
 * AssetTagSchemeService — the brain behind lazyit's first instance-config entity (ADR-0063, #363):
 * the org-wide, single-row, OPT-IN scheme that auto-assigns a running asset tag on create.
 *
 * Two responsibilities:
 *   1. The config surface (`GET`/`PUT /config/asset-tag-scheme`) — read the single row (or its
 *      explicit unset/disabled default) and upsert it.
 *   2. The in-create allocation (`allocateTag`) — when the scheme is ENABLED and the caller did not
 *      pass an explicit tag, atomically allocate the next rendered tag, retrying on a live-tag
 *      collision (P2002 against `assets_assetTag_active_key`, ADR-0041). Gaps are accepted.
 */
@Injectable()
export class AssetTagSchemeService {
  /**
   * The fixed singleton primary key (ADR-0063 §1). The instance has exactly ONE scheme row; a
   * migration CHECK pins the id to this literal, so every read/upsert targets the same row and a
   * second row is structurally impossible.
   */
  static readonly SINGLETON_ID = 'singleton';

  /**
   * Concurrency BACKSTOP only (ADR-0068 §1). The skip-existing PRE-SKIP in {@link allocateTag} jumps
   * the counter past any contiguous occupied block in ONE shot before consuming, so under dense
   * single-actor occupancy this loop runs exactly once — the cap is unreachable in normal operation.
   * Retries here cover ONLY a true concurrent race: two creates that probed the same free slot at the
   * same instant, one losing the live-tag partial-unique index (P2002 on `assets_assetTag_active_key`).
   * Raised well above ADR-0063's old 50 so even a pathological burst of simultaneous creates can't
   * surface a spurious 409, while still bounding a genuine runaway (a misconfigured/looping caller).
   */
  static readonly MAX_ALLOCATION_ATTEMPTS = 10_000;

  /**
   * Hard cap on how many live tags we parse to build the occupied-number set for the pre-skip
   * (ADR-0068 §1) and the seed suggestion (§2). At 5–20-person scale the estate is far smaller; this
   * just bounds the in-memory parse so a pathological dataset can't blow up. The partial-unique index
   * remains the correctness backstop, so an estate beyond this bound still never duplicates a tag — it
   * just falls back to advancing one P2002 at a time past the unparsed tail.
   */
  static readonly OCCUPIED_SCAN_LIMIT = 100_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly history: AssetHistoryService,
    private readonly actor: ActorService,
  ) {}

  /**
   * Read the scheme for the config surface. Returns the explicit UNSET/DISABLED default (enabled
   * false, no affixes, the would-be next number 1) when no row has ever been written — so the
   * frontend always receives a concrete shape, never a 404 for "unset" (ADR-0063 §4).
   */
  async getScheme(): Promise<AssetTagScheme> {
    const row = await this.prisma.assetTagScheme.findFirst({
      where: { id: AssetTagSchemeService.SINGLETON_ID },
    });
    if (!row) {
      const now = new Date();
      return {
        prefix: null,
        suffix: null,
        width: null,
        nextNumber: 1,
        enabled: false,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
    }
    return this.toWire(row);
  }

  /**
   * Upsert the single config row (`PUT`). `enabled`/`prefix`/`suffix`/`width` are set wholesale.
   * `startNumber`, when present, (re)seeds the counter to that NEXT value (e.g. start at 1000); when
   * omitted the counter is left untouched on update and defaults to 1 on first create — so toggling
   * `enabled` never rewinds the sequence (ADR-0063 §1/§4). The shared zod schema already guarantees a
   * sequence is structurally present (no `{num}`-less config is representable), so there is nothing to
   * reject here beyond what validation caught.
   */
  async updateScheme(input: UpdateAssetTagScheme): Promise<AssetTagScheme> {
    // prefix/suffix arrive as `string | undefined`; persist `undefined` as SQL NULL (clear the affix).
    const prefix = input.prefix ?? null;
    const suffix = input.suffix ?? null;
    const width = input.width ?? null;
    const row = await this.prisma.assetTagScheme.upsert({
      where: { id: AssetTagSchemeService.SINGLETON_ID },
      create: {
        id: AssetTagSchemeService.SINGLETON_ID,
        enabled: input.enabled,
        prefix,
        suffix,
        width,
        // On first create, seed the counter from startNumber (default 1 when omitted).
        nextNumber: input.startNumber ?? 1,
      },
      update: {
        enabled: input.enabled,
        prefix,
        suffix,
        width,
        // Only re-seed the counter when startNumber was explicitly supplied; otherwise leave it.
        ...(input.startNumber !== undefined
          ? { nextNumber: input.startNumber }
          : {}),
      },
    });
    return this.toWire(row);
  }

  /**
   * Allocate the auto-assigned tag for a NEW asset, or return `undefined` to fall through to today's
   * behaviour (ADR-0063 §3/§4 · ADR-0068 §1). Returns `undefined` — meaning "do not set an auto-tag"
   * — when:
   *   - the caller passed an explicit `assetTag` (the explicit value ALWAYS wins), or
   *   - no scheme is configured, or the scheme is disabled (OFF by default).
   *
   * Otherwise it allocates the next FREE number (skip-existing invariant) and renders
   * `prefix + zeroPad + suffix`. The number is chosen by {@link consumeNextFreeNumber}: a pre-skip
   * reads the live tags occupying the range at/above the counter and JUMPS the counter past any
   * contiguous occupied block in one shot, then atomically consumes the first free slot — so an
   * auto-tag is NEVER a tag that already exists on a live asset, by construction. The live-tag
   * partial-unique index (`assets_assetTag_active_key`) stays the concurrency backstop: should a
   * concurrent create grab the same slot between our probe and our consume, the asset insert raises a
   * P2002 and the CALLER retries (advancing again — gaps accepted).
   */
  async allocateTag(
    explicitTag: string | undefined,
  ): Promise<string | undefined> {
    if (explicitTag !== undefined) {
      return undefined; // explicit tag wins — never auto-allocate over it.
    }
    const scheme = await this.prisma.assetTagScheme.findFirst({
      where: { id: AssetTagSchemeService.SINGLETON_ID },
    });
    if (!scheme || !scheme.enabled) {
      return undefined; // OFF by default — the create path is byte-for-byte unchanged.
    }
    const affixes = {
      prefix: scheme.prefix,
      suffix: scheme.suffix,
      width: scheme.width,
    };
    // #597: the scheme row was JUST read here, so hand its counter to consume — no second read on the
    // create hot path. The atomic increment inside still re-bases against the live row, so a concurrent
    // racer that advanced the counter between this read and the consume is handled (the increment wins,
    // and the jump's `nextNumber < target` guard never moves it back).
    const allocated = await this.consumeNextFreeNumber(affixes, scheme.nextNumber);
    return renderAssetTag(affixes, allocated);
  }

  /**
   * The SKIP-EXISTING core (ADR-0068 §1). Consume the counter's next FREE number — the smallest
   * `n >= nextNumber` whose rendered tag is not already on a LIVE asset — and durably advance the
   * counter past it. Concurrency- AND dense-occupancy-safe:
   *
   *   1. Determine the current counter (`from`) — either passed in by a caller that JUST read the row
   *      (the create path, #597 — no second read) or read here (the backfill loop, where the counter
   *      advances per iteration and a fresh read is required).
   *   2. Build the set of occupied numbers `>= from` by parsing live tags that match the scheme
   *      affixes (bounded by {@link OCCUPIED_SCAN_LIMIT}); walk forward to the first free `n`.
   *   3. JUMP the counter forward to `n` in ONE atomic `updateMany` (guarded by `nextNumber < n` so it
   *      only ever moves forward, never back under a concurrent racer that already advanced further) —
   *      SKIPPED in the steady state where the counter already sits past the occupied range (#597).
   *   4. CONSUME atomically with the existing `{ increment: 1 }` single-row update; the value BEFORE
   *      the increment is what we allocated. Because the increment is atomic, two concurrent callers
   *      that both jumped to the same `n` get DISTINCT values (`n` and `n+1`) — never a duplicate.
   *
   * The pre-skip is why the {@link MAX_ALLOCATION_ATTEMPTS} cap can't false-409 under dense occupancy:
   * a whole occupied block is skipped in step 3 in one shot, not one P2002 at a time. The freeze at
   * the int4 ceiling (ADR-0063) is preserved — a clean 400 rather than an overflow.
   *
   * @param knownNextNumber the caller's already-read counter; when omitted the row is read here. Only a
   *   FLOOR for the skip walk — the atomic increment is what durably allocates, so a slightly stale hint
   *   (a concurrent racer advanced after the caller's read) still allocates a unique number, never a dup.
   */
  private async consumeNextFreeNumber(
    affixes: {
      prefix: string | null;
      suffix: string | null;
      width: number | null;
    },
    knownNextNumber?: number,
  ): Promise<number> {
    let from: number;
    if (knownNextNumber !== undefined) {
      from = knownNextNumber; // create path: reuse the row allocateTag just read (#597 — no second read).
    } else {
      const current = await this.prisma.assetTagScheme.findFirst({
        where: { id: AssetTagSchemeService.SINGLETON_ID },
        select: { nextNumber: true },
      });
      from = current?.nextNumber ?? 1;
    }
    const occupied = await this.occupiedNumbersFrom(affixes, from);
    const target = nextFreeNumber(occupied, from);
    if (target > INT4_MAX) {
      // The free slot is past the int4 ceiling — freeze with a clean 400 (ADR-0063 edge case).
      throw new BadRequestException(
        'Asset-tag counter exhausted (reached the maximum sequence value).',
      );
    }
    // JUMP forward in one shot — only when there is a contiguous occupied block to skip. In the steady
    // state (counter already past the occupied range → target === from) this is SKIPPED, leaving the
    // atomic increment as the single write (#597). Guarded by `nextNumber < target` so it only ever
    // moves forward, never back under a concurrent racer that already advanced further.
    if (target > from) {
      await this.prisma.assetTagScheme.updateMany({
        where: { id: AssetTagSchemeService.SINGLETON_ID, nextNumber: { lt: target } },
        data: { nextNumber: target },
      });
    }
    // CONSUME atomically: the post-increment value minus one is the number we allocated.
    const updated = await this.prisma.assetTagScheme.update({
      where: { id: AssetTagSchemeService.SINGLETON_ID },
      data: { nextNumber: { increment: 1 } },
    });
    return updated.nextNumber - 1;
  }

  /**
   * Build the set of sequence numbers already taken by LIVE assets whose tag matches the given
   * affixes, considering only numbers `>= from` (the counter floor — earlier numbers can never be
   * re-allocated, so they don't matter for skip-existing). Narrows at the DB with the affix
   * `startsWith`/`endsWith` so we parse only candidate tags, then validates each with the shared
   * {@link parseAssetTagNumber} (prefix + all-digit body + suffix). Bounded by {@link OCCUPIED_SCAN_LIMIT}.
   */
  private async occupiedNumbersFrom(
    affixes: { prefix: string | null; suffix: string | null },
    from: number,
  ): Promise<Set<number>> {
    const rows = await this.prisma.asset.findMany({
      where: {
        deletedAt: null,
        assetTag: {
          not: null,
          ...(affixes.prefix ? { startsWith: affixes.prefix } : {}),
          ...(affixes.suffix ? { endsWith: affixes.suffix } : {}),
        },
      },
      select: { assetTag: true },
      take: AssetTagSchemeService.OCCUPIED_SCAN_LIMIT,
    });
    const occupied = new Set<number>();
    for (const { assetTag } of rows) {
      if (assetTag === null) continue;
      const num = parseAssetTagNumber(affixes, assetTag);
      if (num !== null && num >= from) occupied.add(num);
    }
    return occupied;
  }

  // ===== ADR-0068: existing-estate awareness ================================

  /**
   * Seed suggestion (ADR-0068 §2). From the IN-PROGRESS affixes the admin is editing (not the saved
   * scheme — they may be tweaking prefix/suffix before saving), parse the numeric body out of LIVE
   * tags matching `prefix … suffix` and return `max + 1` as the suggested `startNumber`, so the
   * counter seeds ABOVE the occupied range. `width` is accepted for symmetry with the editor but does
   * not affect parsing (padding is presentational — see {@link parseAssetTagNumber}). Read-only:
   * touches no counter, writes nothing. When nothing matches, suggest 1 (the default first number).
   */
  async seedSuggestion(
    query: AssetTagSeedSuggestionQuery,
  ): Promise<AssetTagSeedSuggestion> {
    const affixes = {
      prefix: query.prefix ?? null,
      suffix: query.suffix ?? null,
    };
    // `from: 0` — count EVERY matching live tag (not just >= a counter), so the suggestion reflects
    // the whole occupied range the admin should seed above.
    const occupied = await this.occupiedNumbersFrom(affixes, 0);
    if (occupied.size === 0) {
      return {
        suggestedStartNumber: 1,
        matchedCount: 0,
        maxExistingNumber: null,
      };
    }
    const max = Math.max(...occupied);
    return {
      suggestedStartNumber: Math.min(max + 1, INT4_MAX),
      matchedCount: occupied.size,
      maxExistingNumber: max,
    };
  }

  /**
   * Backfill PREVIEW (ADR-0068 §4) — read-only, paginated, writes NOTHING (the counter is NOT
   * consumed). Lists exactly the live assets the given mode/scope would retag and, for the page, an
   * INDICATIVE `proposedTag`: a what-if walk from the CURRENT counter over the affected set in a
   * stable order (`createdAt` then `id`), applying skip-existing — but never consuming the counter.
   * Because the projection is indicative, `apply` re-allocates for real (re-validating uniqueness),
   * so preview/apply may differ slightly if the estate drifts between them. Requires the scheme
   * ENABLED (guarded — the frontend hides backfill when disabled, but we 400 defensively).
   */
  async backfillPreview(
    query: AssetTagBackfillPreviewQuery,
  ): Promise<AssetTagBackfillPreview> {
    const scheme = await this.requireEnabledScheme();
    const affixes = {
      prefix: scheme.prefix,
      suffix: scheme.suffix,
      width: scheme.width,
    };

    // The PRECISE affected set, in the stable walk order (createdAt, then id). Computed in JS so the
    // numeric-body conformance test (which SQL can't express) is exact for normalize-non-conforming.
    const affected = await this.affectedRows(query.mode, affixes, query.modelId);
    const total = affected.length;

    // Replay the skip-existing walk from the CURRENT counter over the WHOLE affected set, WITHOUT
    // consuming the counter (indicative only — ADR-0068 §4). The occupied set seeds from the live
    // estate at/above the counter and accumulates each proposed number, so two previewed rows never
    // share one — exactly what apply produces. Then slice the requested page.
    const counter = scheme.nextNumber;
    const occupied = await this.occupiedNumbersFrom(affixes, counter);
    let cursor = counter;
    const proposedById = new Map<string, string>();
    for (const row of affected) {
      cursor = nextFreeNumber(occupied, cursor);
      occupied.add(cursor); // reserve for this what-if walk (no DB write).
      proposedById.set(row.id, renderAssetTag(affixes, cursor));
      cursor += 1;
    }

    const skip = (query.page - 1) * query.pageSize;
    const pageRows = affected.slice(skip, skip + query.pageSize);
    const items: AssetTagBackfillItem[] = pageRows.map((row) => ({
      id: row.id,
      name: row.name ?? row.serial ?? row.assetTag ?? row.id,
      currentTag: row.assetTag,
      proposedTag: proposedById.get(row.id) ?? renderAssetTag(affixes, counter),
      modelId: row.modelId,
      modelName: row.modelName,
    }));

    return {
      items,
      total,
      page: query.page,
      pageSize: query.pageSize,
      mode: query.mode,
    };
  }

  /**
   * Backfill APPLY (ADR-0068 §3) — the deliberate, audited bulk retag. Allocate-and-set for REAL
   * (skip-existing invariant, the counter consumed per row) over `(matching − excludeIds)` in the
   * stable order. Each retag is individually collision-safe: it goes through the SAME
   * {@link consumeNextFreeNumber} the create path uses and a TARGET-AWARE P2002 retry, and writes an
   * `AssetHistory` row (`MODEL`-style {@link RecordAssetEvent}, reusing the asset-history writer) in
   * the same transaction as the tag update. FORWARD-ONLY, no undo. Partial completion is acceptable —
   * a row that keeps colliding past the bounded retry is counted as `skipped`, not a hard failure, so
   * the rest of the batch still commits. Requires the scheme ENABLED (400 otherwise).
   */
  async backfillApply(
    body: AssetTagBackfillApply,
    principal?: Principal,
  ): Promise<AssetTagBackfillResult> {
    const scheme = await this.requireEnabledScheme();
    const affixes = {
      prefix: scheme.prefix,
      suffix: scheme.suffix,
      width: scheme.width,
    };
    const actor = this.actor.resolveActor(principal);

    const exclude = new Set(body.excludeIds);
    const rows = await this.affectedRows(body.mode, affixes, body.modelId);

    let tagged = 0;
    let skipped = 0;
    for (const row of rows) {
      if (exclude.has(row.id)) {
        skipped += 1;
        continue;
      }
      const done = await this.retagOne(row.id, row.assetTag, affixes, actor);
      if (done) tagged += 1;
      else skipped += 1;
    }
    return { tagged, skipped };
  }

  /**
   * Retag ONE asset under the skip-existing invariant, transactionally with its `AssetHistory` row.
   * Bounded retry on a live-tag P2002 (a concurrent grab took the slot): each retry advances to the
   * next free number (gaps accepted). Returns false (counted as `skipped`) if it can't allocate a
   * unique tag within the budget — so a single hot-spot row never aborts the whole backfill.
   */
  private async retagOne(
    assetId: string,
    fromTag: string | null,
    affixes: { prefix: string | null; suffix: string | null; width: number | null },
    actor: RecordAssetEvent['actor'],
  ): Promise<boolean> {
    for (
      let attempt = 0;
      attempt < AssetTagSchemeService.MAX_ALLOCATION_ATTEMPTS;
      attempt++
    ) {
      const allocated = await this.consumeNextFreeNumber(affixes);
      const tag = renderAssetTag(affixes, allocated);
      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.asset.update({
            where: { id: assetId },
            data: { assetTag: tag },
          });
          await this.history.record(tx, {
            assetId,
            // Reuse the existing append-only writer + a generic update event (the enum carries no
            // TAG_CHANGED): the from→to payload makes the retag fully auditable (ADR-0006/0068 §3).
            eventType: 'SPECS_CHANGED',
            payload: { field: 'assetTag', from: fromTag, to: tag },
            actor,
          });
        });
        return true;
      } catch (err) {
        if (isUniqueTagCollision(err)) continue; // a concurrent grab — advance and retry.
        throw err; // anything else (incl. a vanished/soft-deleted row) propagates.
      }
    }
    return false; // exhausted the budget for this row → skipped, batch continues.
  }

  /**
   * The PRECISE set of live assets a backfill scope affects, in the stable walk order (`createdAt`,
   * then `id`). Used identically by preview and apply so the projection and the real run agree on the
   * set and the ordering. Computed in two layers: the DB narrows by mode + `modelId` (always live-
   * only, `deletedAt: null`); for `normalize-non-conforming` the exact numeric-body conformance test
   * (which SQL can't express) is applied in JS via {@link parseAssetTagNumber} — a tag CONFORMS iff it
   * parses to a number, so conforming tags are dropped here and never retagged (ADR-0068 §3). At
   * 5–20-person scale the affected set is small enough to page in memory.
   */
  private async affectedRows(
    mode: AssetTagBackfillMode,
    affixes: { prefix: string | null; suffix: string | null },
    modelId?: string,
  ): Promise<
    Array<{
      id: string;
      name: string | null;
      serial: string | null;
      assetTag: string | null;
      modelId: string | null;
      modelName: string | null;
    }>
  > {
    const base: Prisma.AssetWhereInput = {
      deletedAt: null,
      ...(modelId ? { modelId } : {}),
    };
    // untagged-only never touches a tagged asset, so the DB filter is exact. normalize fetches
    // untagged + ALL tagged (the conformance test is finished in JS below).
    const where: Prisma.AssetWhereInput =
      mode === 'untagged-only' ? { ...base, assetTag: null } : base;

    const rows = await this.prisma.asset.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        serial: true,
        assetTag: true,
        modelId: true,
        model: { select: { name: true } },
      },
    });

    const mapped = rows.map((row) => ({
      id: row.id,
      name: row.name,
      serial: row.serial,
      assetTag: row.assetTag,
      modelId: row.modelId,
      modelName: row.model?.name ?? null,
    }));

    if (mode === 'untagged-only') return mapped;
    // normalize-non-conforming: keep untagged + tagged-but-NOT-conforming; drop conforming tags.
    return mapped.filter(
      (row) =>
        row.assetTag === null ||
        parseAssetTagNumber(affixes, row.assetTag) === null,
    );
  }

  /**
   * Load the saved scheme and require it ENABLED for a backfill (ADR-0068 §3). A backfill with no/
   * disabled scheme is a clean 400 (the frontend won't offer it, but guard anyway). Returns the row.
   */
  private async requireEnabledScheme(): Promise<{
    prefix: string | null;
    suffix: string | null;
    width: number | null;
    nextNumber: number;
    enabled: boolean;
  }> {
    const scheme = await this.prisma.assetTagScheme.findFirst({
      where: { id: AssetTagSchemeService.SINGLETON_ID },
      select: {
        prefix: true,
        suffix: true,
        width: true,
        nextNumber: true,
        enabled: true,
      },
    });
    if (!scheme || !scheme.enabled) {
      throw new BadRequestException(
        'The asset-tag scheme must be enabled before a backfill can run.',
      );
    }
    return scheme;
  }

  /** Map the Prisma row to the wire shape (Dates -> ISO strings). */
  private toWire(row: {
    prefix: string | null;
    suffix: string | null;
    width: number | null;
    nextNumber: number;
    enabled: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): AssetTagScheme {
    return {
      prefix: row.prefix,
      suffix: row.suffix,
      width: row.width,
      nextNumber: row.nextNumber,
      enabled: row.enabled,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/**
 * Skip-existing walk (ADR-0068 §1), PURE so it is exhaustively unit-testable. Given a set of OCCUPIED
 * numbers and a `from` floor, return the smallest `n >= from` that is NOT occupied. Advancing one at a
 * time is fine: the set only holds numbers at/above the counter, and a contiguous occupied block is
 * walked through here in memory (the DB jump in {@link AssetTagSchemeService} consumes the result in
 * one atomic step). Example: occupied {1000,1002,1005}, from 1000 → 1001; called again from 1002 →
 * 1003; from 1003 → 1003 (free); from 1005 → 1006.
 */
export function nextFreeNumber(occupied: Set<number>, from: number): number {
  let n = from;
  while (occupied.has(n)) n += 1;
  return n;
}

/**
 * The name of the raw partial-unique index that enforces live-tag uniqueness (created in raw SQL in
 * migration 20260601130000, NOT a PSL `@unique` — Prisma can't express the `WHERE deletedAt IS NULL`
 * partial). Because Prisma doesn't know this index from the schema, a P2002 raised by it surfaces
 * `meta.target` as the INDEX NAME string here (rather than a `["assetTag"]` column array). We still
 * match the column-array shape defensively in case the surfaced shape ever changes.
 */
const ASSET_TAG_UNIQUE_INDEX = 'assets_assetTag_active_key';
const ASSET_TAG_COLUMN = 'assetTag';

/**
 * Type guard for the live-tag unique collision: a P2002 raised by the `assets_assetTag_active_key`
 * partial-unique index (ADR-0041/0063). It must be TARGET-AWARE — `Asset` has TWO live-only partial
 * uniques (serial AND assetTag), so a duplicate-`serial` create with an auto-tag in play would
 * otherwise be misclassified as a tag collision and spin the whole retry budget (burning ~50 counter
 * numbers) before a misleading 409. Only an assetTag collision advances-and-retries; any other P2002
 * (serial, or anything else) returns false and propagates immediately to the global filter as a
 * prompt, correct 409 — no counter waste.
 *
 * `meta.target` is inspected following the established shape in `prisma-exception.filter.ts`. We match
 * BOTH the raw-index shape (a string equal to / containing the index name — what adapter-pg surfaces
 * for this raw partial index) AND the column-array shape (an array including `assetTag`), so the guard
 * is robust to either.
 */
export function isUniqueTagCollision(err: unknown): boolean {
  if (
    !(err instanceof Prisma.PrismaClientKnownRequestError) ||
    err.code !== 'P2002'
  ) {
    return false;
  }
  const target = err.meta?.target;
  if (typeof target === 'string') {
    // Raw partial index: adapter-pg surfaces the index NAME (e.g. "assets_assetTag_active_key").
    return (
      target === ASSET_TAG_UNIQUE_INDEX || target.includes(ASSET_TAG_COLUMN)
    );
  }
  if (Array.isArray(target)) {
    // Column-array shape (defensive): a P2002 whose target lists the assetTag column / index name.
    return target.some(
      (t) => t === ASSET_TAG_COLUMN || t === ASSET_TAG_UNIQUE_INDEX,
    );
  }
  // No usable target (e.g. a bare P2002) → cannot confirm it is the assetTag index, so DON'T retry.
  return false;
}
