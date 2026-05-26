import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateApplicationCategory,
  UpdateApplicationCategory,
} from '@lazyit/shared';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ApplicationCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  /** All non-deleted categories, ordered by `order` (nulls last) then name. */
  findAll() {
    return this.prisma.applicationCategory.findMany({
      orderBy: [{ order: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
    });
  }

  /** A single non-deleted category by id; throws 404 if missing or deleted. */
  async findOne(id: string) {
    const category = await this.prisma.applicationCategory.findFirst({
      where: { id },
    });
    if (!category) {
      throw new NotFoundException(`ApplicationCategory ${id} not found`);
    }
    return category;
  }

  create(data: CreateApplicationCategory) {
    return this.prisma.applicationCategory.create({ data });
  }

  async update(id: string, data: UpdateApplicationCategory) {
    await this.findOne(id); // 404 if missing or already soft-deleted
    return this.prisma.applicationCategory.update({ where: { id }, data });
  }

  /**
   * Soft delete: set deletedAt. No 409 guard like ArticleCategory — `Application.categoryId` is an
   * optional FK with `onDelete: SetNull`, so deleting a category simply detaches its applications
   * (it never orphans a required relation). See ADR-0023.
   */
  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.applicationCategory.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
