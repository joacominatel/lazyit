import { Injectable, NotFoundException } from '@nestjs/common';
import type { AssetStatus, CreateAsset, UpdateAsset } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Non-deleted assets (expanded with model/category, location, activeAssignments+user), newest
   * first. Optional filters: category (via the model), location, status, and `q` (substring over
   * name/serial/assetTag).
   */
  async findAll(filters: AssetFilters = {}) {
    const { categoryId, locationId, status, q } = filters;
    const assets = await this.prisma.asset.findMany({
      where: {
        deletedAt: null,
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
      where: { id, deletedAt: null },
      include: ASSET_RELATIONS,
    });
    if (!asset) {
      throw new NotFoundException(`Asset ${id} not found`);
    }
    return this.toExpanded(asset);
  }

  /** Create. Invalid modelId/locationId hit the FK and are mapped to 400 by PrismaExceptionFilter. */
  create(data: CreateAsset) {
    const { specs, ...rest } = data;
    return this.prisma.asset.create({
      // specs is free-form jsonb; zod's Record<string, unknown> needs a cast to Prisma's Json input.
      data: {
        ...rest,
        ...(specs !== undefined
          ? { specs: specs as Prisma.InputJsonValue }
          : {}),
      },
    });
  }

  async update(id: string, data: UpdateAsset) {
    await this.assertExists(id); // 404 if missing or already soft-deleted
    const { specs, ...rest } = data;
    return this.prisma.asset.update({
      where: { id },
      data: {
        ...rest,
        ...(specs !== undefined
          ? { specs: specs as Prisma.InputJsonValue }
          : {}),
      },
    });
  }

  /** Soft delete: set deletedAt. Never hard-delete (auditability is a first principle). */
  async remove(id: string) {
    await this.assertExists(id);
    return this.prisma.asset.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /** Lightweight 404 guard for writes and the nested assignments endpoint (no relation loading). */
  async assertExists(id: string): Promise<void> {
    const asset = await this.prisma.asset.findFirst({
      where: { id, deletedAt: null },
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
}
