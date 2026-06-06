import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  AssetStatus,
  BatchResult,
  CreateAsset,
  PageQuery,
  UpdateAsset,
} from '@lazyit/shared';
import {
  applyAssetModelSpecsDefaults,
  offsetOf,
  pageOf,
} from '@lazyit/shared';
import { resolveSortOrBadRequest } from '../common/resolve-sort';
import { deletedWhere, includeSoftDeletedFor } from '../common/deleted-filter';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService, type ActorAttribution } from '../common/actor.service';
import type { Principal } from '../auth/principal';
import { jsonDeepEqual } from '../common/deep-equal';
import {
  AssetHistoryService,
  type RecordAssetEvent,
} from '../asset-history/asset-history.service';
import { SearchService } from '../search/search.service';
import { projectAsset } from '../search/search.documents';

/** Optional filters for listing assets. `categoryId` filters by the asset's model's category. */
export interface AssetFilters {
  categoryId?: string;
  locationId?: string;
  status?: AssetStatus;
  /** Case-insensitive substring over name / serial / assetTag (OR). */
  q?: string;
}

/**
 * Server-side sort allowlist for `GET /assets` (ADR-0030 amendment). Maps each PUBLIC `?sort=` key to
 * the Prisma column to order by — bounding the sortable surface to a curated set. An unknown key is a
 * 400 (resolveSortOrBadRequest). With no `sort`, the list keeps its default `createdAt desc` order.
 */
export const ASSET_SORT_ALLOWLIST = {
  name: 'name',
  assetTag: 'assetTag',
  serial: 'serial',
  status: 'status',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
} as const;

// Inline relations for the expanded reads (GET /assets, GET /assets/:id): the model (+ its
// category, which lives on the model), the location, and the *active* owners (releasedAt = null)
// each with their user. One nested include → a constant number of queries, never N+1.
const ASSET_RELATIONS = {
  model: { include: { category: true } },
  location: true,
  assignments: {
    where: { releasedAt: null },
    orderBy: { assignedAt: 'desc' },
    include: { user: true },
  },
} satisfies Prisma.AssetInclude;

type AssetWithIncludes = Prisma.AssetGetPayload<{
  include: typeof ASSET_RELATIONS;
}>;

// Lean projection for the LIST (GET /assets, paginated). Unlike the detail graph it (1) omits the
// `specs` jsonb blob the table never renders and (2) trims each join (model+category, location,
// active owners) to only the fields the list shows — not the full related rows. Keeps the full graph
// on findOne. See packages/shared/src/schemas/asset-list.ts and ADR-0030 / the perf analysis (#2).
const ASSET_LIST_SELECT = {
  id: true,
  name: true,
  serial: true,
  assetTag: true,
  status: true,
  notes: true,
  purchaseDate: true,
  warrantyEnd: true,
  modelId: true,
  locationId: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  model: {
    select: {
      id: true,
      name: true,
      manufacturer: true,
      category: { select: { id: true, name: true } },
    },
  },
  location: { select: { id: true, name: true, type: true } },
  assignments: {
    where: { releasedAt: null },
    orderBy: { assignedAt: 'desc' },
    select: {
      id: true,
      userId: true,
      user: {
        // `deletedAt` is carried so the LIST can dim a departed (soft-deleted) owner's avatar,
        // matching the detail read (ADR-0030 amendment, 2026-06-01 — re-added after Round 1 dropped it).
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          deletedAt: true,
        },
      },
    },
  },
} satisfies Prisma.AssetSelect;

type AssetWithLeanSelect = Prisma.AssetGetPayload<{
  select: typeof ASSET_LIST_SELECT;
}>;

@Injectable()
export class AssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actor: ActorService,
    private readonly history: AssetHistoryService,
    private readonly search: SearchService,
  ) {}

  /**
   * A single page of assets (the inventory pillar's main, heaviest list), newest first. Uses the
   * LEAN projection ({@link ASSET_LIST_SELECT}): no `specs` blob and trimmed joins — the full
   * relation graph stays on {@link findOne}. Runs the page `findMany(take/skip)` and the `count`
   * over the **same** `where` inside one `$transaction`, so the `total` can't drift from the page.
   * Optional filters: category (via the model), location, status, and `q` (substring over
   * name/serial/assetTag). The `deleted` slice (`active` default | `only`) scopes the page to live or
   * soft-deleted assets; `only` carries the ADR-0032 `includeSoftDeleted` escape hatch so the read
   * filter doesn't re-hide them (ADMIN-gated at the controller).
   */
  async findPage(filters: AssetFilters = {}, page: PageQuery) {
    const where = {
      ...this.buildWhere(filters),
      ...deletedWhere(page.deleted),
    };
    const includeSoftDeleted = includeSoftDeletedFor(page.deleted);
    const { take, skip } = offsetOf(page);
    // Server-side sort over the FULL result set (not page-local) via the per-resource allowlist
    // (ADR-0030 amendment). No `sort` ⇒ undefined ⇒ the default `createdAt desc` order below.
    const orderBy =
      resolveSortOrBadRequest<Prisma.AssetOrderByWithRelationInput>(
        page,
        ASSET_SORT_ALLOWLIST,
      ) ??
      ({ createdAt: 'desc' } satisfies Prisma.AssetOrderByWithRelationInput);
    // `includeSoftDeleted` is the ADR-0032 custom arg (stripped by the extension before Prisma sees
    // it); Prisma's generated args type carries it only as `undefined`, so spread it in via an opaque
    // object — keeping the `select` inference intact so the lean row type is preserved.
    const escapeHatch: Record<string, unknown> = includeSoftDeleted
      ? { includeSoftDeleted }
      : {};
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.asset.findMany({
        where,
        orderBy,
        take,
        skip,
        select: ASSET_LIST_SELECT,
        ...escapeHatch,
      }),
      this.prisma.asset.count({ where, ...escapeHatch }),
    ]);
    // The lean rows carry `Date`s; the API serializes them to ISO strings at the HTTP boundary (same
    // as findOne) — the AssetListPage DTO documents the resulting wire shape (specs omitted, joins
    // trimmed). The `assignments` relation is renamed to `activeAssignments` for the response.
    const items = rows.map((row) => this.toLeanListItem(row));
    return pageOf(items, total, page);
  }

  /** The shared `where` for the asset list — used identically by findPage and its count. */
  private buildWhere({
    categoryId,
    locationId,
    status,
    q,
  }: AssetFilters): Prisma.AssetWhereInput {
    return {
      ...(locationId ? { locationId } : {}),
      ...(status ? { status } : {}),
      // Category lives on the model, not the asset: match assets whose model is in it.
      ...(categoryId ? { model: { categoryId } } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { serial: { contains: q, mode: 'insensitive' } },
              { assetTag: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
  }

  /** A single non-deleted asset by id, expanded with its relations; 404 if missing or deleted. */
  async findOne(id: string) {
    const asset = await this.prisma.asset.findFirst({
      where: { id },
      include: ASSET_RELATIONS,
    });
    if (!asset) {
      throw new NotFoundException(`Asset ${id} not found`);
    }
    return this.toExpanded(asset);
  }

  /**
   * Create. Emits a `CREATED` history event transactionally with the insert (ADR-0033); the actor
   * comes from the authenticated User (ADR-0038). Invalid modelId/locationId hit the FK → 400.
   */
  async create(data: CreateAsset, principal?: Principal) {
    const actor = this.actor.resolveActor(principal);
    const { specs, ...rest } = data;
    const asset = await this.prisma.$transaction(async (tx) => {
      let resolvedSpecs = specs;
      if (rest.modelId) {
        const model = await tx.assetModel.findFirst({
          where: { id: rest.modelId },
          select: { specs: true },
        });
        if (!model) {
          throw new BadRequestException(`AssetModel ${rest.modelId} not found`);
        }
        resolvedSpecs = applyAssetModelSpecsDefaults(
          model.specs as Record<string, unknown> | null,
          specs,
        );
      }
      // specs is free-form jsonb; zod's Record<string, unknown> needs a cast to Prisma's Json input.
      const created = await tx.asset.create({
        data: {
          ...rest,
          ...(resolvedSpecs !== undefined
            ? { specs: resolvedSpecs as Prisma.InputJsonValue }
            : {}),
        },
      });
      await this.history.record(tx, {
        assetId: created.id,
        eventType: 'CREATED',
        actor,
      });
      return created;
    });
    // Fire-and-forget search sync after the commit (ADR-0035): un-awaited, never throws, no-op when
    // Meili is disabled. Outside the transaction so a search outage can't roll back the write.
    this.search.upsert('assets', projectAsset(asset));
    return asset;
  }

  /**
   * Partial update. Emits a discrete history event per changed dimension (status / location / model
   * / specs), transactionally with the update (ADR-0033). 404 if missing or already soft-deleted.
   */
  async update(id: string, data: UpdateAsset, principal?: Principal) {
    const actor = this.actor.resolveActor(principal);
    const before = await this.prisma.asset.findFirst({
      where: { id },
      select: {
        id: true,
        status: true,
        locationId: true,
        modelId: true,
        specs: true,
      },
    });
    if (!before) {
      throw new NotFoundException(`Asset ${id} not found`);
    }
    const { specs, ...rest } = data;
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.asset.update({
        where: { id },
        data: {
          ...rest,
          ...(specs !== undefined
            ? { specs: specs as Prisma.InputJsonValue }
            : {}),
        },
      });
      for (const event of this.changeEvents(before, row, actor)) {
        await this.history.record(tx, event);
      }
      return row;
    });
    // Fire-and-forget search sync after the commit (ADR-0035): re-index the updated row.
    this.search.upsert('assets', projectAsset(updated));
    return updated;
  }

  /** Soft delete: set deletedAt (never hard-delete). Emits `DELETED` transactionally (ADR-0033). */
  async remove(id: string, principal?: Principal) {
    const actor = this.actor.resolveActor(principal);
    await this.assertExists(id);
    const deleted = await this.prisma.$transaction(async (tx) => {
      const row = await tx.asset.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      await this.history.record(tx, {
        assetId: id,
        eventType: 'DELETED',
        actor,
      });
      return row;
    });
    // Drop from the index so soft-deleted assets never surface in search (ADR-0035).
    this.search.remove('assets', id);
    return deleted;
  }

  /**
   * Restore a soft-deleted asset: clear `deletedAt` and emit a `RESTORED` history event
   * transactionally (ADR-0033 / ADR-0041) — the counterpart of `remove()`/`DELETED`. The row is found
   * via the `includeSoftDeleted` escape hatch (the read filter hides soft-deleted assets). 404 if it
   * never existed; idempotent (no event) if already live. The partial unique indexes free
   * serial/assetTag on delete, so a restore can 409 if another live asset took one of them in the
   * meantime (mapped by the global PrismaExceptionFilter). Re-indexes for search on success.
   */
  async restore(id: string, principal?: Principal) {
    const actor = this.actor.resolveActor(principal);
    const existing = await this.prisma.asset.findFirst({
      where: { id },
      select: { id: true, deletedAt: true },
      includeSoftDeleted: true,
    } as Prisma.AssetFindFirstArgs);
    if (!existing) {
      throw new NotFoundException(`Asset ${id} not found`);
    }
    if (existing.deletedAt === null) {
      // Already live — return the expanded view; no RESTORED event for a no-op.
      return this.findOne(id);
    }
    const restored = await this.prisma.$transaction(async (tx) => {
      const row = await tx.asset.update({
        where: { id },
        data: { deletedAt: null },
      });
      await this.history.record(tx, {
        assetId: id,
        eventType: 'RESTORED',
        actor,
      });
      return row;
    });
    // Re-index the restored asset (ADR-0035).
    this.search.upsert('assets', projectAsset(restored));
    // Return the expanded relation graph (same shape as findOne), consistent with the no-op branch.
    return this.findOne(id);
  }

  // --- batch (bulk) actions (ADR-0030 amendment) ---------------------------
  // Each batch runs in ONE transaction but keeps PER-ENTITY auditability: one AssetHistory event per
  // item, exactly as the single-item action records it — never one event for the whole batch. A
  // batch is a convenience over N single actions, not a different audit event. Ids that are a no-op
  // (already deleted/restored, already in the target status, or not found) are SKIPPED (reported in
  // the result), never an error, so a partial multi-select still commits. Search sync is fired once
  // per mutated row after the commit (same fire-and-forget contract as the single-item paths).

  /**
   * Bulk soft-delete (ADMIN). For each live id: stamp `deletedAt` + emit a `DELETED` history event,
   * all inside one `$transaction`. An id that is missing or already soft-deleted is skipped (not an
   * error). Returns the per-id outcome. Drops each mutated id from the search index after the commit.
   */
  async batchRemove(
    ids: string[],
    principal?: Principal,
  ): Promise<BatchResult> {
    const actor = this.actor.resolveActor(principal);
    const live = await this.prisma.asset.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    const liveIds = new Set(live.map((a) => a.id));
    const succeeded = [...liveIds];
    const skipped = ids
      .filter((id) => !liveIds.has(id))
      .map((id) => ({ id, reason: 'not_found' }));

    if (succeeded.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        for (const id of succeeded) {
          await tx.asset.update({
            where: { id },
            data: { deletedAt: new Date() },
          });
          await this.history.record(tx, {
            assetId: id,
            eventType: 'DELETED',
            actor,
          });
        }
      });
      for (const id of succeeded) this.search.remove('assets', id);
    }
    return { requested: ids.length, succeeded, skipped };
  }

  /**
   * Bulk restore (ADMIN). For each soft-deleted id: clear `deletedAt` + emit a `RESTORED` history
   * event, all inside one `$transaction`. An id that is missing or already live is skipped. Returns
   * the per-id outcome and re-indexes each restored row after the commit. A unique-constraint clash
   * on a freed serial/assetTag surfaces as the usual 409 (the whole batch rolls back).
   */
  async batchRestore(
    ids: string[],
    principal?: Principal,
  ): Promise<BatchResult> {
    const actor = this.actor.resolveActor(principal);
    const rows = await this.prisma.asset.findMany({
      where: { id: { in: ids } },
      select: { id: true, deletedAt: true },
      includeSoftDeleted: true,
    } as Prisma.AssetFindManyArgs);
    const found = new Map(rows.map((r) => [r.id, r.deletedAt]));
    const succeeded: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of ids) {
      if (!found.has(id)) skipped.push({ id, reason: 'not_found' });
      else if (found.get(id) === null)
        skipped.push({ id, reason: 'already_in_state' });
      else succeeded.push(id);
    }

    if (succeeded.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        for (const id of succeeded) {
          await tx.asset.update({
            where: { id },
            data: { deletedAt: null },
          });
          await this.history.record(tx, {
            assetId: id,
            eventType: 'RESTORED',
            actor,
          });
        }
      });
      for (const id of succeeded) {
        const row = await this.prisma.asset.findFirst({ where: { id } });
        if (row) this.search.upsert('assets', projectAsset(row));
      }
    }
    return { requested: ids.length, succeeded, skipped };
  }

  /**
   * Bulk status-change (ADMIN). For each live id whose status DIFFERS from the target: set the new
   * status + emit a `STATUS_CHANGED` history event ({ from, to }) — identical to the single-item
   * update path — inside one `$transaction`. An id already at the target status is skipped (no event,
   * matching the no-op semantics of `update`). Missing/soft-deleted ids are skipped as not found.
   * Re-indexes each changed row after the commit.
   */
  async batchSetStatus(
    ids: string[],
    status: AssetStatus,
    principal?: Principal,
  ): Promise<BatchResult> {
    const actor = this.actor.resolveActor(principal);
    const live = await this.prisma.asset.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true },
    });
    const current = new Map(live.map((a) => [a.id, a.status]));
    const succeeded: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of ids) {
      if (!current.has(id)) skipped.push({ id, reason: 'not_found' });
      else if (current.get(id) === status)
        skipped.push({ id, reason: 'already_in_state' });
      else succeeded.push(id);
    }

    if (succeeded.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        for (const id of succeeded) {
          await tx.asset.update({ where: { id }, data: { status } });
          await this.history.record(tx, {
            assetId: id,
            eventType: 'STATUS_CHANGED',
            payload: {
              from: current.get(id),
              to: status,
            },
            actor,
          });
        }
      });
      for (const id of succeeded) {
        const row = await this.prisma.asset.findFirst({ where: { id } });
        if (row) this.search.upsert('assets', projectAsset(row));
      }
    }
    return { requested: ids.length, succeeded, skipped };
  }

  /** Lightweight 404 guard for writes and the nested assignments endpoint (no relation loading). */
  async assertExists(id: string): Promise<void> {
    const asset = await this.prisma.asset.findFirst({
      where: { id },
      select: { id: true },
    });
    if (!asset) {
      throw new NotFoundException(`Asset ${id} not found`);
    }
  }

  /** Rename the Prisma `assignments` relation (filtered to active) to the response's `activeAssignments`. */
  private toExpanded(asset: AssetWithIncludes) {
    const { assignments, ...rest } = asset;
    return { ...rest, activeAssignments: assignments };
  }

  /** Same `assignments` -> `activeAssignments` rename for the lean LIST row (AssetListItem). */
  private toLeanListItem(asset: AssetWithLeanSelect) {
    const { assignments, ...rest } = asset;
    return { ...rest, activeAssignments: assignments };
  }

  /** One discrete history event per field that actually changed in an update (ADR-0033). */
  private changeEvents(
    before: Pick<
      Prisma.AssetGetPayload<{
        select: {
          status: true;
          locationId: true;
          modelId: true;
          specs: true;
        };
      }>,
      'status' | 'locationId' | 'modelId' | 'specs'
    >,
    updated: { id: string } & typeof before,
    actor?: ActorAttribution,
  ): RecordAssetEvent[] {
    const events: RecordAssetEvent[] = [];
    const change = (
      eventType: RecordAssetEvent['eventType'],
      from: unknown,
      to: unknown,
    ) =>
      events.push({
        assetId: updated.id,
        eventType,
        payload: { from, to } as Prisma.InputJsonValue,
        actor,
      });
    if (before.status !== updated.status) {
      change('STATUS_CHANGED', before.status, updated.status);
    }
    if (before.locationId !== updated.locationId) {
      change('LOCATION_CHANGED', before.locationId, updated.locationId);
    }
    if (before.modelId !== updated.modelId) {
      change('MODEL_CHANGED', before.modelId, updated.modelId);
    }
    if (!jsonDeepEqual(before.specs, updated.specs)) {
      // Order-insensitive deep compare (not JSON.stringify): jsonb does not preserve object key
      // order, so reordered specs keys must not emit a spurious SPECS_CHANGED (see deep-equal.ts).
      // specs can be large; record the change without echoing both blobs into the payload.
      events.push({
        assetId: updated.id,
        eventType: 'SPECS_CHANGED',
        actor,
      });
    }
    return events;
  }
}
