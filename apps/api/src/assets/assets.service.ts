import { Injectable, NotFoundException } from '@nestjs/common';
import type { AssetStatus, CreateAsset, UpdateAsset } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
import {
  AssetHistoryService,
  type RecordAssetEvent,
} from '../asset-history/asset-history.service';

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

@Injectable()
export class AssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actor: ActorService,
    private readonly history: AssetHistoryService,
  ) {}

  /**
   * Non-deleted assets (expanded with model/category, location, activeAssignments+user), newest
   * first. Optional filters: category (via the model), location, status, and `q` (substring over
   * name/serial/assetTag).
   */
  async findAll(filters: AssetFilters = {}) {
    const { categoryId, locationId, status, q } = filters;
    const assets = await this.prisma.asset.findMany({
      where: {
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
      },
      orderBy: { createdAt: 'desc' },
      include: ASSET_RELATIONS,
    });
    return assets.map((asset) => this.toExpanded(asset));
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
    return this.prisma.$transaction(async (tx) => {
      // specs is free-form jsonb; zod's Record<string, unknown> needs a cast to Prisma's Json input.
      const asset = await tx.asset.create({
        data: {
          ...rest,
          ...(specs !== undefined
            ? { specs: specs as Prisma.InputJsonValue }
            : {}),
        },
      });
      await this.history.record(tx, {
        assetId: asset.id,
        eventType: 'CREATED',
        performedById,
      });
      return asset;
    });
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
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.asset.update({
        where: { id },
        data: {
          ...rest,
          ...(specs !== undefined
            ? { specs: specs as Prisma.InputJsonValue }
            : {}),
        },
      });
      for (const event of this.changeEvents(before, updated, performedById)) {
        await this.history.record(tx, event);
      }
      return updated;
    });
  }

  /** Soft delete: set deletedAt (never hard-delete). Emits `DELETED` transactionally (ADR-0033). */
  async remove(id: string, actorId?: string) {
    const performedById = await this.actor.resolve(actorId);
    await this.assertExists(id);
    return this.prisma.$transaction(async (tx) => {
      const deleted = await tx.asset.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      await this.history.record(tx, {
        assetId: id,
        eventType: 'DELETED',
        performedById,
      });
      return deleted;
    });
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
