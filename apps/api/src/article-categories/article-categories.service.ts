import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateArticleCategory,
  FolderAccessRules,
  UpdateArticleCategory,
} from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Folders (ADR-0059 §1) — the hierarchical evolution of the flat ArticleCategory. The model/table
 * stay `ArticleCategory` / `article_categories` and the endpoints stay `/article-categories` (the
 * rename to Folder/folders is a deliberate follow-up); this service gains the tree semantics: a
 * `parentId` self-FK, a DFS cycle guard (a folder may not be its own ancestor) and a no-silent-orphan
 * delete (a folder with live CHILD folders is a 409, mirroring the existing live-articles 409). No
 * access semantics live here — ADR-0060 attaches the per-folder permission boundary later.
 */
@Injectable()
export class ArticleCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  /** All non-deleted categories, ordered by `order` (nulls last) then name. */
  findAll() {
    return this.prisma.articleCategory.findMany({
      orderBy: [{ order: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
    });
  }

  /** A single non-deleted category by id; throws 404 if missing or deleted. */
  async findOne(id: string) {
    const category = await this.prisma.articleCategory.findFirst({
      where: { id },
    });
    if (!category) {
      throw new NotFoundException(`ArticleCategory ${id} not found`);
    }
    return category;
  }

  /**
   * Create a folder. An optional `parentId` nests it under another folder (absent = a root folder);
   * the parent must be a live folder (400 otherwise). A new folder has no children, so no cycle is
   * possible. Folder-name uniqueness is per-parent among live rows (partial unique index → 409 on a
   * duplicate, mapped by the global PrismaExceptionFilter).
   */
  async create(data: CreateArticleCategory) {
    if (data.parentId !== undefined) {
      await this.assertParentUsable(data.parentId);
    }
    return this.prisma.articleCategory.create({ data });
  }

  /**
   * Update a folder. When `parentId` is present it MOVES the folder: `null` → the root, a cuid →
   * reparent under a live folder (400 if it doesn't exist). A move that would make the folder its own
   * ancestor is rejected with 400 (the DFS cycle guard). Name uniqueness stays per-parent (409 on a
   * duplicate within the new parent).
   */
  async update(id: string, data: UpdateArticleCategory) {
    await this.findOne(id); // 404 if missing or already soft-deleted
    if (data.parentId !== undefined && data.parentId !== null) {
      await this.assertParentUsable(data.parentId);
      await this.assertNoFolderCycle(id, data.parentId);
    }
    return this.prisma.articleCategory.update({ where: { id }, data });
  }

  /**
   * Soft delete. Refuses with 409 if the folder still has live articles (the home-folder FK can't be
   * orphaned — reassign/delete those articles first) OR live CHILD folders (a non-empty subtree is
   * never silently orphaned — ADR-0059 §1; reparent/delete the children first). Both guards are
   * application logic: our delete is a soft delete (UPDATE deletedAt) which does not fire the FK's
   * referential action — the schema FKs are only hard-delete safety nets. See ADR-0021 / ADR-0019.
   */
  async remove(id: string) {
    await this.findOne(id);
    const liveArticles = await this.prisma.article.count({
      where: { categoryId: id },
    });
    if (liveArticles > 0) {
      throw new ConflictException(
        `Cannot delete folder: ${liveArticles} article(s) still use it. Move or delete them first.`,
      );
    }
    const liveChildren = await this.prisma.articleCategory.count({
      where: { parentId: id },
    });
    if (liveChildren > 0) {
      throw new ConflictException(
        `Cannot delete folder: ${liveChildren} sub-folder(s) still nest under it. Move or delete them first.`,
      );
    }
    return this.prisma.articleCategory.update({
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
    const category = await this.prisma.articleCategory.findFirst({
      where: { id },
      includeSoftDeleted: true,
    } as Prisma.ArticleCategoryFindFirstArgs);
    if (!category) {
      throw new NotFoundException(`ArticleCategory ${id} not found`);
    }
    if (category.deletedAt === null) {
      return category; // already live — idempotent
    }
    return this.prisma.articleCategory.update({
      where: { id },
      data: { deletedAt: null },
    });
  }

  // --- folder access control (ADR-0060 §3) ----------------------------------

  /**
   * Set or clear a folder's access rules (ADR-0060 §3 — the per-folder permission boundary). The body
   * is the OR-combined CLOSED rule vocabulary (validated against `UpdateFolderAccessRulesSchema` at the
   * DTO edge): a non-null list RESTRICTS the folder (narrows the audience from public); `null` CLEARS
   * the restriction (makes the folder PUBLIC again, §2). 404 if the folder is missing or soft-deleted.
   *
   * The rule is stored as jsonb on the folder — NOT a per-article ACL (INV-9): N articles inherit their
   * home folder's rule, so access is authored once per folder. The dynamic kinds (appGrant /
   * assetAssignment) are evaluated DB-first at READ time (FolderAccessService) over the live joins, so a
   * stored rule is never materialised and access follows offboarding automatically. Only ADMIN reaches
   * this (the route is `settings:manage`-gated): a folder ACL is an authorization-management surface.
   */
  async setAccessRules(id: string, accessRules: FolderAccessRules) {
    await this.findOne(id); // 404 if missing or already soft-deleted
    return this.prisma.articleCategory.update({
      where: { id },
      data: {
        // jsonb column: a rule list is stored verbatim; null clears it (Prisma DbNull writes SQL NULL).
        accessRules:
          accessRules === null
            ? Prisma.DbNull
            : (accessRules as unknown as Prisma.InputJsonValue),
      },
    });
  }

  // --- folder hierarchy guards (ADR-0059 §1) --------------------------------

  /** 400 if parentId doesn't reference a live (non-soft-deleted) folder. */
  private async assertParentUsable(parentId: string): Promise<void> {
    const parent = await this.prisma.articleCategory.findFirst({
      where: { id: parentId },
      select: { id: true },
    });
    if (!parent) {
      throw new BadRequestException(
        `parentId ${parentId} does not reference a live folder`,
      );
    }
  }

  /**
   * Reject a reparent that would make `subjectId` its own ancestor (a cycle — 400). Walks UP the
   * chain from the proposed parent: if we ever reach the subject, the move would close a loop. The
   * same DFS pattern the manager chain (ADR-0058) and the workflow step graph (ADR-0054 §8) use;
   * trees are shallow in a 5–20-person KB, so the cost is negligible. A `visited` set guards against
   * any pre-existing loop in the data so the walk always terminates.
   */
  private async assertNoFolderCycle(
    subjectId: string,
    proposedParentId: string,
  ): Promise<void> {
    if (proposedParentId === subjectId) {
      throw new BadRequestException('A folder cannot be its own parent');
    }
    const visited = new Set<string>([proposedParentId]);
    let cursor: string | null = proposedParentId;
    while (cursor != null) {
      if (cursor === subjectId) {
        throw new BadRequestException(
          'Moving this folder there would create a folder cycle',
        );
      }
      const next: { parentId: string | null } | null =
        await this.prisma.articleCategory.findFirst({
          where: { id: cursor },
          select: { parentId: true },
        });
      cursor = next?.parentId ?? null;
      if (cursor != null) {
        if (visited.has(cursor)) {
          break; // pre-existing loop in the data — stop (the move doesn't involve the subject)
        }
        visited.add(cursor);
      }
    }
  }
}
