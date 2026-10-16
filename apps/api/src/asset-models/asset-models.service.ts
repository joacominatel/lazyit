import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AssetModelDeleteImpact,
  CreateAssetModel,
  DeleteResolution,
  PageQuery,
  UpdateAssetModel,
} from '@lazyit/shared';
import { DELETE_IMPACT_SAMPLE_LIMIT, offsetOf, pageOf } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { resolveSortOrBadRequest } from '../common/resolve-sort';
import { deletedWhere, includeSoftDeletedFor } from '../common/deleted-filter';
import { deleteResolutionRequired } from '../common/delete-resolution';
import { ActorService, type ActorAttribution } from '../common/actor.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import type { Principal } from '../auth/principal';
import { recordPurchaseOrderEvent } from '../purchase-orders/purchase-order-events';
import { receivedUnitsSql } from '../purchase-orders/purchase-order-line-receipt';

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

/**
 * Live assets only (#1540): `usageCount` counts what an operator sees in the inventory. A relation
 * `_count` is not rewritten by the ADR-0032 read filter, so the `deletedAt: null` is explicit. It
 * applies to both slices: an archived model's row still shows the live assets that point at it.
 */
const LIVE_ASSET_COUNT = {
  _count: { select: { assets: { where: { deletedAt: null } } } },
} as const satisfies Prisma.AssetModelInclude;

type ModelWithCount = Prisma.AssetModelGetPayload<{
  include: typeof LIVE_ASSET_COUNT;
}>;

function withUsageCount(row: ModelWithCount) {
  const { _count, ...model } = row;
  return { ...model, usageCount: _count.assets };
}

/** A delete may re-point thousands of assets and write their history; allow it more than the 5 s default. */
export const ASSET_MODEL_DELETE_TX_TIMEOUT_MS = 30_000;

// Only these stored statuses still expect units; CANCELLED and any status a newer build adds keep their model.
const OPEN_PURCHASE_STATUSES = ['DRAFT', 'ORDERED'];

interface OpenLine {
  id: string;
  purchaseOrderId: string;
  reference: string | null;
  description: string;
}

@Injectable()
export class AssetModelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actor: ActorService,
    private readonly history: AssetHistoryService,
    private readonly permissions: PermissionResolverService,
  ) {}

  /**
   * A single page of asset models (default `createdAt desc`). Server-side `q` search (over
   * name/manufacturer/sku) + an optional `categoryId` filter + an allowlisted sort make the list
   * authoritative — migrated off the raw-array contract that materialized every model client-side
   * just to populate the picker (issue #199, ADR-0030). The `deleted` slice (`active` default |
   * `only`) scopes the page to live or soft-deleted rows; `only` carries the ADR-0032
   * `includeSoftDeleted` escape hatch so the read filter doesn't re-hide them (ADMIN-gated at the
   * controller). Runs `findMany(take/skip)` + `count` over the same `where` in one `$transaction`.
   * Each row on the page carries the computed `usageCount` of its live assets (#1540) — a relation
   * aggregate inside the same `findMany`, not a per-row lookup.
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
        include: LIVE_ASSET_COUNT,
        ...escapeHatch,
      }),
      this.prisma.assetModel.count({ where, ...escapeHatch }),
    ]);
    return pageOf(items.map(withUsageCount), total, page);
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

  /** Create. A missing or archived categoryId is a 400. */
  async create(data: CreateAssetModel) {
    await this.assertCategoryLive(data.categoryId);
    const { specs, ...rest } = data;
    return this.prisma.assetModel.create({
      // specs is free-form jsonb; zod's Record<string, unknown> needs a cast to Prisma's Json input.
      data: {
        ...rest,
        ...(specs !== undefined
          ? { specs: specs as Prisma.InputJsonValue }
          : {}),
      },
    });
  }

  async update(id: string, data: UpdateAssetModel) {
    const existing = await this.findOne(id); // 404 if missing or already soft-deleted
    // Only a changed category is checked, so a model already filed under an archived one stays editable.
    if (data.categoryId !== existing.categoryId) {
      await this.assertCategoryLive(data.categoryId);
    }
    const { specs, ...rest } = data;
    return this.prisma.assetModel.update({
      where: { id },
      data: {
        ...rest,
        ...(specs !== undefined
          ? { specs: specs as Prisma.InputJsonValue }
          : {}),
      },
    });
  }

  /** What a delete would re-point or detach; each list only for a reader of that kind. */
  async deleteImpact(
    id: string,
    principal?: Principal,
  ): Promise<AssetModelDeleteImpact> {
    await this.findOne(id);
    const [canAssets, canPurchases] = await Promise.all([
      this.permissions.principalHas(principal, 'asset:read'),
      this.permissions.principalHas(principal, 'purchaseOrder:read'),
    ]);
    const assetsWhere = { modelId: id, deletedAt: null };
    const [assetTotal, assets, lines] = await Promise.all([
      this.prisma.asset.count({ where: assetsWhere }),
      canAssets
        ? this.prisma.asset.findMany({
            where: assetsWhere,
            select: { id: true, name: true, assetTag: true },
            orderBy: { name: 'asc' },
            take: DELETE_IMPACT_SAMPLE_LIMIT,
          })
        : null,
      this.openLines(this.prisma, id),
    ]);
    return {
      assets: { total: assetTotal, items: assets },
      purchaseOrderLines: {
        total: lines.length,
        items: canPurchases ? lines.slice(0, DELETE_IMPACT_SAMPLE_LIMIT) : null,
      },
    };
  }

  /** Soft delete; live assets and open purchase lines still on the model need the one `resolution`, in the same transaction. */
  async remove(
    id: string,
    resolution?: DeleteResolution,
    principal?: Principal,
  ) {
    const actor = this.actor.resolveActor(principal);
    return this.prisma.$transaction(
      async (tx) => {
        const targetId =
          resolution?.strategy === 'move' ? resolution.targetId : undefined;
        // Both rows in id order, so two deletes moving into each other cannot deadlock.
        const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "asset_models"
         WHERE "id" IN (${Prisma.join(targetId ? [id, targetId] : [id])})
           AND "deletedAt" IS NULL
         ORDER BY "id" FOR UPDATE`;
        if (!locked.some((row) => row.id === id)) {
          throw new NotFoundException(`AssetModel ${id} not found`);
        }
        const assets = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "assets"
         WHERE "modelId" = ${id} AND "deletedAt" IS NULL
         ORDER BY "id" FOR UPDATE`;
        // Purchase before line, as every purchase write locks; SHARE also waits out a status change or archive in flight.
        await tx.$queryRaw`
        SELECT "id" FROM "purchase_orders"
         WHERE "id" IN (SELECT "purchaseOrderId" FROM "purchase_order_lines"
                         WHERE "assetModelId" = ${id} AND "deletedAt" IS NULL)
         ORDER BY "id" FOR SHARE`;
        const lines = await this.openLines(tx, id, true);
        if (assets.length + lines.length > 0) {
          if (!resolution) {
            throw deleteResolutionRequired(`AssetModel ${id}`, {
              assets: assets.length,
              purchaseOrderLines: lines.length,
            });
          }
          if (targetId === id) {
            throw new BadRequestException(
              'Choose another model to move to, not the one being deleted.',
            );
          }
          if (targetId && !locked.some((row) => row.id === targetId)) {
            throw new BadRequestException(
              `Target model ${targetId} not found (missing or archived).`,
            );
          }
          await this.resolveDependents(tx, id, targetId ?? null, actor, {
            assetIds: assets.map((a) => a.id),
            lines,
          });
        }
        return tx.assetModel.update({
          where: { id },
          data: { deletedAt: new Date() },
        });
      },
      { timeout: ASSET_MODEL_DELETE_TX_TIMEOUT_MS },
    );
  }

  /**
   * Restore a soft-deleted model: clear `deletedAt` (ADR-0041). Found via the `includeSoftDeleted`
   * escape hatch (the read filter would hide it). 404 if it never existed; idempotent if already
   * live. The partial unique index frees `sku` on delete, so a restore can 409 if another live model
   * took the sku in the meantime (mapped by the global PrismaExceptionFilter). A model whose category is
   * still archived is a 409 too: restores do not cascade, so restore the category first.
   */
  async restore(id: string) {
    return this.prisma.$transaction(async (tx) => {
      const model = await tx.assetModel.findFirst({
        where: { id },
        includeSoftDeleted: true,
      } as Prisma.AssetModelFindFirstArgs);
      if (!model) {
        throw new NotFoundException(`AssetModel ${id} not found`);
      }
      if (model.deletedAt === null) {
        return model; // already live — idempotent
      }
      if (model.categoryId !== null) {
        // SHARE waits out a category delete in flight, which then sees this model as live.
        const category = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "asset_categories"
           WHERE "id" = ${model.categoryId} AND "deletedAt" IS NULL
           FOR SHARE`;
        if (category.length === 0) {
          throw new ConflictException(
            `Cannot restore asset model ${id}: its category ${model.categoryId} is archived. Restore the category first.`,
          );
        }
      }
      return tx.assetModel.update({
        where: { id },
        data: { deletedAt: null },
      });
    });
  }
  // --- delete resolution (SEC-041) -----------------------------------------

  private async resolveDependents(
    tx: Prisma.TransactionClient,
    from: string,
    to: string | null,
    actor: ActorAttribution,
    rows: { assetIds: string[]; lines: OpenLine[] },
  ): Promise<void> {
    if (rows.assetIds.length > 0) {
      await tx.asset.updateMany({
        where: { id: { in: rows.assetIds } },
        data: { modelId: to },
      });
      await this.history.recordMany(
        tx,
        rows.assetIds.map((assetId) => ({
          assetId,
          eventType: 'MODEL_CHANGED' as const,
          payload: { from, to },
          actor,
        })),
      );
    }
    if (rows.lines.length > 0) {
      await tx.purchaseOrderLine.updateMany({
        where: { id: { in: rows.lines.map((line) => line.id) } },
        data: { assetModelId: to },
      });
      for (const line of rows.lines) {
        await recordPurchaseOrderEvent(
          tx,
          line.purchaseOrderId,
          'LINE_UPDATED',
          actor,
          { lineId: line.id, changes: { assetModelId: { from, to } } },
        );
      }
    }
  }

  /** Live lines mapped to the model, in a live open purchase, still expecting units. */
  private openLines(
    client: Prisma.TransactionClient | PrismaService,
    modelId: string,
    lock = false,
  ): Promise<OpenLine[]> {
    return client.$queryRaw<OpenLine[]>`
      SELECT l."id", l."purchaseOrderId", po."reference", l."description"
        FROM "purchase_order_lines" l
        JOIN "purchase_orders" po ON po."id" = l."purchaseOrderId"
       WHERE l."assetModelId" = ${modelId}
         AND l."deletedAt" IS NULL
         AND po."deletedAt" IS NULL
         AND po."status" IN (${Prisma.join(OPEN_PURCHASE_STATUSES)})
         AND l."quantity" - l."cancelledQuantity" - ${receivedUnitsSql()} > 0
       ORDER BY po."createdAt" ASC, l."position" ASC, l."id" ASC
       ${lock ? Prisma.sql`FOR UPDATE OF l` : Prisma.empty}`;
  }

  /** 400 unless the category a write names is live; the FK alone cannot tell an archived one from a live one. */
  private async assertCategoryLive(
    categoryId: string | null | undefined,
  ): Promise<void> {
    if (!categoryId) return;
    const category = await this.prisma.assetCategory.findFirst({
      where: { id: categoryId, deletedAt: null },
      select: { id: true },
    });
    if (!category) {
      throw new BadRequestException(
        `AssetCategory ${categoryId} not found (missing or archived)`,
      );
    }
  }
}
