import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DELETE_IMPACT_SAMPLE_LIMIT,
  type ConsumableCategoryDeleteImpact,
  type CreateConsumableCategory,
  type DeleteResolution,
  type UpdateConsumableCategory,
} from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import type { Principal } from '../auth/principal';
import { deleteResolutionRequired } from '../common/delete-resolution';

/**
 * Live consumables only (#1540): `usageCount` counts what an operator sees in the catalog. `Consumable`
 * is NOT auto-scoped by the ADR-0032 read filter (and a relation `_count` never is), so the
 * `deletedAt: null` is explicit.
 */
const LIVE_CONSUMABLE_COUNT = {
  _count: { select: { consumables: { where: { deletedAt: null } } } },
} as const satisfies Prisma.ConsumableCategoryInclude;

type CategoryWithCount = Prisma.ConsumableCategoryGetPayload<{
  include: typeof LIVE_CONSUMABLE_COUNT;
}>;

function withUsageCount(row: CategoryWithCount) {
  const { _count, ...category } = row;
  return { ...category, usageCount: _count.consumables };
}

@Injectable()
export class ConsumableCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionResolverService,
  ) {}

  /**
   * All non-deleted categories, ordered by `order` (nulls last) then name, each with the computed
   * `usageCount` of live consumables filed under it (#1540) — one query, the count is a relation
   * aggregate, not a per-row lookup. Only this list read carries it; single reads and writes do not.
   */
  async findAll() {
    const rows = await this.prisma.consumableCategory.findMany({
      orderBy: [{ order: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
      include: LIVE_CONSUMABLE_COUNT,
    });
    return rows.map(withUsageCount);
  }

  /** A single non-deleted category by id; throws 404 if missing or deleted. */
  async findOne(id: string) {
    const category = await this.prisma.consumableCategory.findFirst({
      where: { id },
    });
    if (!category) {
      throw new NotFoundException(`ConsumableCategory ${id} not found`);
    }
    return category;
  }

  create(data: CreateConsumableCategory) {
    return this.prisma.consumableCategory.create({ data });
  }

  async update(id: string, data: UpdateConsumableCategory) {
    await this.findOne(id); // 404 if missing or already soft-deleted
    return this.prisma.consumableCategory.update({ where: { id }, data });
  }

  /** The live consumables a delete would detach or move; the list only when the caller may read consumables. */
  async deleteImpact(
    id: string,
    principal?: Principal,
  ): Promise<ConsumableCategoryDeleteImpact> {
    await this.findOne(id);
    const where = { categoryId: id, deletedAt: null };
    const [total, items] = await Promise.all([
      this.prisma.consumable.count({ where }),
      (await this.permissions.principalHas(principal, 'consumable:read'))
        ? this.prisma.consumable.findMany({
            where,
            select: { id: true, name: true, sku: true },
            orderBy: { name: 'asc' },
            take: DELETE_IMPACT_SAMPLE_LIMIT,
          })
        : null,
    ]);
    return { consumables: { total, items } };
  }

  /** Soft delete; live consumables still filed here need the one `resolution`, applied in the same transaction. */
  async remove(id: string, resolution?: DeleteResolution) {
    return this.prisma.$transaction(async (tx) => {
      const targetId =
        resolution?.strategy === 'move' ? resolution.targetId : undefined;
      // Both rows in id order, so two deletes moving into each other cannot deadlock.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "consumable_categories"
         WHERE "id" IN (${Prisma.join(targetId ? [id, targetId] : [id])})
           AND "deletedAt" IS NULL
         ORDER BY "id" FOR UPDATE`;
      if (!locked.some((row) => row.id === id)) {
        throw new NotFoundException(`ConsumableCategory ${id} not found`);
      }
      const affected = await tx.consumable.findMany({
        where: { categoryId: id, deletedAt: null },
        select: { id: true },
      });
      if (affected.length > 0) {
        if (!resolution) {
          throw deleteResolutionRequired(`ConsumableCategory ${id}`, {
            consumables: affected.length,
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
        await tx.consumable.updateMany({
          where: { id: { in: affected.map((row) => row.id) }, categoryId: id },
          data: { categoryId: targetId ?? null },
        });
      }
      return tx.consumableCategory.update({
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
    const category = await this.prisma.consumableCategory.findFirst({
      where: { id },
      includeSoftDeleted: true,
    } as Prisma.ConsumableCategoryFindFirstArgs);
    if (!category) {
      throw new NotFoundException(`ConsumableCategory ${id} not found`);
    }
    if (category.deletedAt === null) {
      return category; // already live — idempotent
    }
    return this.prisma.consumableCategory.update({
      where: { id },
      data: { deletedAt: null },
    });
  }
}
