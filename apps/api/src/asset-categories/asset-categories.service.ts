import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DELETE_IMPACT_SAMPLE_LIMIT,
  type AssetCategoryDeleteImpact,
  type CreateAssetCategory,
  type DeleteResolution,
  type UpdateAssetCategory,
} from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import type { Principal } from '../auth/principal';
import { deleteResolutionRequired } from '../common/delete-resolution';

/**
 * The usage of an asset category is reached THROUGH its models (#1540): an asset carries `modelId`, the
 * model carries `categoryId`. So the list read pulls each category's LIVE models with their count of
 * LIVE assets, and sums them. Nested relation reads are not rewritten by the ADR-0032 read filter, so
 * both `deletedAt: null` are explicit: an asset of an archived model is not counted against the
 * category (the archived model is the thing still in use, and its own row shows that).
 */
const LIVE_MODEL_ASSET_COUNTS = {
  models: {
    where: { deletedAt: null },
    select: {
      _count: { select: { assets: { where: { deletedAt: null } } } },
    },
  },
} as const satisfies Prisma.AssetCategoryInclude;

type CategoryWithModelCounts = Prisma.AssetCategoryGetPayload<{
  include: typeof LIVE_MODEL_ASSET_COUNTS;
}>;

function withUsageCount(row: CategoryWithModelCounts) {
  const { models, ...category } = row;
  const usageCount = models.reduce((sum, m) => sum + m._count.assets, 0);
  return { ...category, usageCount };
}

const liveModelsOf = (categoryId: string) =>
  ({ categoryId, deletedAt: null }) satisfies Prisma.AssetModelWhereInput;

const liveAssetsOf = (categoryId: string) =>
  ({
    deletedAt: null,
    model: { categoryId, deletedAt: null },
  }) satisfies Prisma.AssetWhereInput;

@Injectable()
export class AssetCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionResolverService,
  ) {}

  /**
   * All categories that have not been soft-deleted, alphabetically (it's a reference list), each with
   * the computed `usageCount` of live assets whose live model is filed under it (#1540). One Prisma
   * read: the models and their asset counts are batched relation aggregates, never a per-row lookup.
   * Only this list read carries it; single reads and writes do not.
   */
  async findAll() {
    const rows = await this.prisma.assetCategory.findMany({
      orderBy: { name: 'asc' },
      include: LIVE_MODEL_ASSET_COUNTS,
    });
    return rows.map(withUsageCount);
  }

  /** A single non-deleted category by id; throws 404 if missing or deleted. */
  async findOne(id: string) {
    const category = await this.prisma.assetCategory.findFirst({
      where: { id },
    });
    if (!category) {
      throw new NotFoundException(`AssetCategory ${id} not found`);
    }
    return category;
  }

  create(data: CreateAssetCategory) {
    // specsSchema is the advisory declarative dictionary (ADR-0007 amendment, #851): a jsonb field.
    // Omitted from the write when absent so an unset category stores NULL (no governance) —
    // byte-for-byte the pre-#851 create path for callers that don't use it.
    const { specsSchema, ...rest } = data;
    return this.prisma.assetCategory.create({
      data: { ...rest, ...(specsSchema !== undefined ? { specsSchema } : {}) },
    });
  }

  async update(id: string, data: UpdateAssetCategory) {
    await this.findOne(id); // 404 if missing or already soft-deleted
    // A caller replaces the whole dictionary; `specsSchema: []` clears it (no governance).
    const { specsSchema, ...rest } = data;
    return this.prisma.assetCategory.update({
      where: { id },
      data: { ...rest, ...(specsSchema !== undefined ? { specsSchema } : {}) },
    });
  }

  /** The live models a delete would detach or move, and their live assets; each list only for a reader of that kind. */
  async deleteImpact(
    id: string,
    principal?: Principal,
  ): Promise<AssetCategoryDeleteImpact> {
    await this.findOne(id);
    const [canModels, canAssets] = await Promise.all([
      this.permissions.principalHas(principal, 'assetModel:read'),
      this.permissions.principalHas(principal, 'asset:read'),
    ]);
    const modelsWhere = liveModelsOf(id);
    const assetsWhere = liveAssetsOf(id);
    const [modelTotal, models, assetTotal, assets] = await Promise.all([
      this.prisma.assetModel.count({ where: modelsWhere }),
      canModels
        ? this.prisma.assetModel.findMany({
            where: modelsWhere,
            select: { id: true, name: true, manufacturer: true },
            orderBy: { name: 'asc' },
            take: DELETE_IMPACT_SAMPLE_LIMIT,
          })
        : null,
      this.prisma.asset.count({ where: assetsWhere }),
      canAssets
        ? this.prisma.asset.findMany({
            where: assetsWhere,
            select: { id: true, name: true, assetTag: true },
            orderBy: { name: 'asc' },
            take: DELETE_IMPACT_SAMPLE_LIMIT,
          })
        : null,
    ]);
    return {
      assetModels: { total: modelTotal, items: models },
      assets: { total: assetTotal, items: assets },
    };
  }

  /** Soft delete; live models still filed here need the one `resolution`, applied in the same transaction. */
  async remove(id: string, resolution?: DeleteResolution) {
    return this.prisma.$transaction(async (tx) => {
      const targetId =
        resolution?.strategy === 'move' ? resolution.targetId : undefined;
      // Both rows in id order, so two deletes moving into each other cannot deadlock.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "asset_categories"
         WHERE "id" IN (${Prisma.join(targetId ? [id, targetId] : [id])})
           AND "deletedAt" IS NULL
         ORDER BY "id" FOR UPDATE`;
      if (!locked.some((row) => row.id === id)) {
        throw new NotFoundException(`AssetCategory ${id} not found`);
      }
      const affected = await tx.assetModel.findMany({
        where: liveModelsOf(id),
        select: { id: true },
      });
      if (affected.length > 0) {
        if (!resolution) {
          throw deleteResolutionRequired(`AssetCategory ${id}`, {
            assetModels: affected.length,
            assets: await tx.asset.count({ where: liveAssetsOf(id) }),
          });
        }
        if (targetId === id) {
          throw new BadRequestException(
            'Choose another category to move to, not the one being deleted.',
          );
        }
        if (targetId && !locked.some((row) => row.id === targetId)) {
          throw new BadRequestException(
            `Target category ${targetId} not found (missing or archived).`,
          );
        }
        await tx.assetModel.updateMany({
          where: { id: { in: affected.map((row) => row.id) }, categoryId: id },
          data: { categoryId: targetId ?? null },
        });
      }
      return tx.assetCategory.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    });
  }

  /**
   * Restore a soft-deleted category: clear `deletedAt` (ADR-0041). Found via the `includeSoftDeleted`
   * escape hatch (the read filter would hide it). 404 if it never existed; idempotent if already
   * live. The partial unique index frees `name` on delete, so a restore can 409 if another live
   * category took the name in the meantime (mapped by the global PrismaExceptionFilter).
   */
  async restore(id: string) {
    const category = await this.prisma.assetCategory.findFirst({
      where: { id },
      includeSoftDeleted: true,
    } as Prisma.AssetCategoryFindFirstArgs);
    if (!category) {
      throw new NotFoundException(`AssetCategory ${id} not found`);
    }
    if (category.deletedAt === null) {
      return category; // already live — idempotent
    }
    return this.prisma.assetCategory.update({
      where: { id },
      data: { deletedAt: null },
    });
  }
}
