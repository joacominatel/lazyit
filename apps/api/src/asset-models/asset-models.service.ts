import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateAssetModel,
  PageQuery,
  UpdateAssetModel,
} from '@lazyit/shared';
import { offsetOf, pageOf } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { resolveSortOrBadRequest } from '../common/resolve-sort';
import { deletedWhere, includeSoftDeletedFor } from '../common/deleted-filter';

/** Optional filters for listing asset models. */
export interface AssetModelFilters {
  /** Case-insensitive substring over name / manufacturer / sku (OR). */
  q?: string;
  /** Scope to one asset category (already cuid-validated at the controller). */
  categoryId?: string;
}

/**
 * Server-side sort allowlist for `GET /asset-models` (ADR-0030 amendment). Maps each PUBLIC `?sort=`
 * key to the Prisma column. Unknown key → 400. With no `sort`, the list keeps its default
 * `createdAt desc`.
 */
export const ASSET_MODEL_SORT_ALLOWLIST = {
  name: 'name',
  manufacturer: 'manufacturer',
  sku: 'sku',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
} as const;

@Injectable()
export class AssetModelsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A single page of asset models (default `createdAt desc`). Server-side `q` search (over
   * name/manufacturer/sku) + an optional `categoryId` filter + an allowlisted sort make the list
   * authoritative — migrated off the raw-array contract that materialized every model client-side
   * just to populate the picker (issue #199, ADR-0030). The `deleted` slice (`active` default |
   * `only`) scopes the page to live or soft-deleted rows; `only` carries the ADR-0032
   * `includeSoftDeleted` escape hatch so the read filter doesn't re-hide them (ADMIN-gated at the
   * controller). Runs `findMany(take/skip)` + `count` over the same `where` in one `$transaction`.
   */
  async findPage(filters: AssetModelFilters, page: PageQuery) {
    const where = {
      ...this.buildWhere(filters),
      ...deletedWhere(page.deleted),
    };
    const includeSoftDeleted = includeSoftDeletedFor(page.deleted);
    const { take, skip } = offsetOf(page);
    const orderBy =
      resolveSortOrBadRequest<Prisma.AssetModelOrderByWithRelationInput>(
        page,
        ASSET_MODEL_SORT_ALLOWLIST,
      ) ??
      ({
        createdAt: 'desc',
      } satisfies Prisma.AssetModelOrderByWithRelationInput);
    // `includeSoftDeleted` is the ADR-0032 custom arg (stripped by the extension before Prisma sees
    // it); Prisma's generated args type carries it only as `undefined`, so spread it in via an opaque
    // object rather than fighting the type.
    const escapeHatch: Record<string, unknown> = includeSoftDeleted
      ? { includeSoftDeleted }
      : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.assetModel.findMany({
        where,
        orderBy,
        take,
        skip,
        ...escapeHatch,
      }),
      this.prisma.assetModel.count({ where, ...escapeHatch }),
    ]);
    return pageOf(items, total, page);
  }

  /** The shared `where` for the model list — used identically by findPage and its count. */
  private buildWhere({
    q,
    categoryId,
  }: AssetModelFilters): Prisma.AssetModelWhereInput {
    return {
      ...(categoryId ? { categoryId } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { manufacturer: { contains: q, mode: 'insensitive' } },
              { sku: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
  }

  /** A single non-deleted model by id; throws 404 if missing or deleted. */
  async findOne(id: string) {
    const model = await this.prisma.assetModel.findFirst({
      where: { id },
    });
    if (!model) {
      throw new NotFoundException(`AssetModel ${id} not found`);
    }
    return model;
  }

  /** Create. An invalid categoryId hits the FK and is mapped to 400 by PrismaExceptionFilter. */
  create(data: CreateAssetModel) {
    const { specs, ...rest } = data;
    return this.prisma.assetModel.create({
      // specs is free-form jsonb; zod's Record<string, unknown> needs a cast to Prisma's Json input.
      data: {
        ...rest,
        ...(specs !== undefined ? { specs: specs as Prisma.InputJsonValue } : {}),
      },
    });
  }

  async update(id: string, data: UpdateAssetModel) {
    await this.findOne(id); // 404 if missing or already soft-deleted
    const { specs, ...rest } = data;
    return this.prisma.assetModel.update({
      where: { id },
      data: {
        ...rest,
        ...(specs !== undefined ? { specs: specs as Prisma.InputJsonValue } : {}),
      },
    });
  }

  /** Soft delete: set deletedAt. Never hard-delete (auditability is a first principle). */
  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.assetModel.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * Restore a soft-deleted model: clear `deletedAt` (ADR-0041). Found via the `includeSoftDeleted`
   * escape hatch (the read filter would hide it). 404 if it never existed; idempotent if already
   * live. The partial unique index frees `sku` on delete, so a restore can 409 if another live model
   * took the sku in the meantime (mapped by the global PrismaExceptionFilter).
   */
  async restore(id: string) {
    const model = await this.prisma.assetModel.findFirst({
      where: { id },
      includeSoftDeleted: true,
    } as Prisma.AssetModelFindFirstArgs);
    if (!model) {
      throw new NotFoundException(`AssetModel ${id} not found`);
    }
    if (model.deletedAt === null) {
      return model; // already live — idempotent
    }
    return this.prisma.assetModel.update({
      where: { id },
      data: { deletedAt: null },
    });
  }
}
