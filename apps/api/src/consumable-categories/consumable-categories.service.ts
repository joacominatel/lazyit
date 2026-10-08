import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateConsumableCategory,
  UpdateConsumableCategory,
} from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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
  constructor(private readonly prisma: PrismaService) {}

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

  /**
   * Soft delete: set deletedAt. No 409 guard — `Consumable.categoryId` is an optional FK with
   * `onDelete: SetNull`, so deleting a category simply detaches its consumables (it never orphans
   * a required relation). See ADR-0023 / ADR-0034.
   */
  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.consumableCategory.update({
      where: { id },
      data: { deletedAt: new Date() },
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
