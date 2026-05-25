import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateArticleCategory,
  UpdateArticleCategory,
} from '@lazyit/shared';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ArticleCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  /** All non-deleted categories, ordered by `order` (nulls last) then name. */
  findAll() {
    return this.prisma.articleCategory.findMany({
      where: { deletedAt: null },
      orderBy: [{ order: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
    });
  }

  /** A single non-deleted category by id; throws 404 if missing or deleted. */
  async findOne(id: string) {
    const category = await this.prisma.articleCategory.findFirst({
      where: { id, deletedAt: null },
    });
    if (!category) {
      throw new NotFoundException(`ArticleCategory ${id} not found`);
    }
    return category;
  }

  create(data: CreateArticleCategory) {
    return this.prisma.articleCategory.create({ data });
  }

  async update(id: string, data: UpdateArticleCategory) {
    await this.findOne(id); // 404 if missing or already soft-deleted
    return this.prisma.articleCategory.update({ where: { id }, data });
  }

  /**
   * Soft delete. Refuses with 409 if the category still has live articles: `categoryId` is a
   * required FK, so orphaning is impossible — the caller must reassign/delete those articles first.
   * The schema's `onDelete: Restrict` is only a hard-delete safety net (our delete is an UPDATE, so
   * it never fires), which is why this guard is application logic. See ADR-0021 and ADR-0019.
   */
  async remove(id: string) {
    await this.findOne(id);
    const liveArticles = await this.prisma.article.count({
      where: { categoryId: id, deletedAt: null },
    });
    if (liveArticles > 0) {
      throw new ConflictException(
        `Cannot delete category: ${liveArticles} article(s) still use it. Move or delete them first.`,
      );
    }
    return this.prisma.articleCategory.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
