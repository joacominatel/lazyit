import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  AssetStatus,
  CreateAsset,
  PageQuery,
  UpdateAsset,
} from '@lazyit/shared';
import { offsetOf, pageOf } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
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

// Lean projection for the LIST (GET /assets): omit the `specs` jsonb (which can be large and is
// only rendered on the detail page) and trim each relation to the fields a table row renders.
// `select` (not `include`) so unselected scalars — chiefly `specs` — never leave the DB. The full
// shape (incl. `specs` + the complete relation graph) is still returned by GET /assets/:id.
// Mirrors AssetListItemSchema in @lazyit/shared. See ADR-0030 / SEC-007.
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
      assetId: true,
      userId: true,
      assignedAt: true,
      user: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
    },
  },
} satisfies Prisma.AssetSelect;

type AssetListRow = Prisma.AssetGetPayload<{
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
   * Paginated list of non-deleted assets (ADR-0030), newest first, as a `Page` envelope. Each row is
   * a **lean** projection — the `specs` jsonb is omitted and `model`/`location`/`activeAssignments`
   * are trimmed to the fields a table renders (see {@link ASSET_LIST_SELECT}); the full shape is on
   * `GET /assets/:id`. Optional filters: category (via the model), location, status, and `q`
   * (substring over name/serial/assetTag). `total` counts every match, ignoring the page window.
   */
  async findPage(filters: AssetFilters = {}, page: PageQuery) {
    const where = this.buildWhere(filters);
    const { take, skip } = offsetOf(page);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.asset.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        select: ASSET_LIST_SELECT,
        take,
        skip,
      }),
      this.prisma.asset.count({ where }),
    ]);
    return pageOf(
      rows.map((row) => this.toListItem(row)),
      total,
      page,
    );
  }

  /** The shared `where` for the asset list — feeds both the page query and its count (ADR-0030). */
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
   * comes from the X-User-Id shim. Invalid modelId/locationId hit the FK and are mapped to 400.
   */
  async create(data: CreateAsset, actorId?: string) {
    const performedById = await this.actor.resolve(actorId);
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
  async update(id: string, data: UpdateAsset, actorId?: string) {
    const performedById = await this.actor.resolve(actorId);
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
  async remove(id: string, actorId?: string) {
    const performedById = await this.actor.resolve(actorId);
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

  /**
   * Lean list row → response item: rename the filtered `assignments` relation to `activeAssignments`
   * (no `specs`). Matches `AssetListItem` in @lazyit/shared at the wire level; the `Date` fields are
   * serialized to ISO strings by Nest at the HTTP boundary (same as the expanded reads).
   */
  private toListItem(asset: AssetListRow) {
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
    if (
      JSON.stringify(before.specs ?? null) !==
      JSON.stringify(updated.specs ?? null)
    ) {
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
