import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateConsumableCategory,
  UpdateConsumableCategory,
} from '@lazyit/shared';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ConsumableCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  /** All non-deleted categories, ordered by `order` (nulls last) then name. */
  findAll() {
    return this.prisma.consumableCategory.findMany({
      orderBy: [{ order: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
    });
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
}
