import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  AssetStatus,
  CreateAsset,
  PageQuery,
  UpdateAsset,
} from '@lazyit/shared';
import { offsetOf, pageOf } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import type { User } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
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
        select: { id: true, firstName: true, lastName: true, email: true },
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
   * A single page of non-deleted assets (the inventory pillar's main, heaviest list), newest first.
   * Uses the LEAN projection ({@link ASSET_LIST_SELECT}): no `specs` blob and trimmed joins — the
   * full relation graph stays on {@link findOne}. Runs the page `findMany(take/skip)` and the `count`
   * over the **same** `where` inside one `$transaction`, so the `total` can't drift from the page.
   * Optional filters: category (via the model), location, status, and `q` (substring over
   * name/serial/assetTag).
   */
  async findPage(filters: AssetFilters = {}, page: PageQuery) {
    const where = this.buildWhere(filters);
    const { take, skip } = offsetOf(page);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.asset.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        select: ASSET_LIST_SELECT,
      }),
      this.prisma.asset.count({ where }),
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
  async create(data: CreateAsset, user?: User) {
    const performedById = this.actor.resolve(user);
    const { specs, ...rest } = data;
    const asset = await this.prisma.$transaction(async (tx) => {
      // specs is free-form jsonb; zod's Record<string, unknown> needs a cast to Prisma's Json input.
      const created = await tx.asset.create({
        data: {
          ...rest,
          ...(specs !== undefined
            ? { specs: specs as Prisma.InputJsonValue }
            : {}),
        },
      });
      await this.history.record(tx, {
        assetId: created.id,
        eventType: 'CREATED',
        performedById,
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
  async update(id: string, data: UpdateAsset, user?: User) {
    const performedById = this.actor.resolve(user);
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
      for (const event of this.changeEvents(before, row, performedById)) {
        await this.history.record(tx, event);
      }
      return row;
    });
    // Fire-and-forget search sync after the commit (ADR-0035): re-index the updated row.
    this.search.upsert('assets', projectAsset(updated));
    return updated;
  }

  /** Soft delete: set deletedAt (never hard-delete). Emits `DELETED` transactionally (ADR-0033). */
  async remove(id: string, user?: User) {
    const performedById = this.actor.resolve(user);
    await this.assertExists(id);
    const deleted = await this.prisma.$transaction(async (tx) => {
      const row = await tx.asset.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      await this.history.record(tx, {
        assetId: id,
        eventType: 'DELETED',
        performedById,
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
  async restore(id: string, user?: User) {
    const performedById = this.actor.resolve(user);
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
        performedById,
      });
      return row;
    });
    // Re-index the restored asset (ADR-0035).
    this.search.upsert('assets', projectAsset(restored));
    // Return the expanded relation graph (same shape as findOne), consistent with the no-op branch.
    return this.findOne(id);
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
    performedById?: string,
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
        performedById,
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
        performedById,
      });
    }
    return events;
  }
}
