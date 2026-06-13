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

/** Shape returned by a successful cascade delete. */
export interface CascadeDeleteResult {
  /** Total folders soft-deleted (the root + every descendant). */
  deletedFolders: number;
  /** Total articles soft-deleted across the whole subtree. */
  deletedArticles: number;
}

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
   * Cascade soft-delete: soft-delete the target folder, ALL descendant folders (the full subtree),
   * and ALL articles whose home `categoryId` is anywhere in that subtree. Hard-deletes all
   * ArticleAlias rows whose `folderId` is in the deleted subtree OR whose `articleId` points to a
   * soft-deleted article in the subtree (aliases are nav-only; a dead alias is pure noise).
   * ArticleWikiLink.resolvedTargetId pointing at soft-deleted articles is left stale — the read paths
   * already filter these (ADR-0059 §3/§4).
   *
   * Idempotent on an already-deleted or non-existent folder: 404.
   * Empty subtree: deletes just the root folder; counts return 0/0 for articles/children beyond it.
   *
   * ADMIN-only: the caller must hold `category:delete` (the existing gate). The author-only article
   * gate is deliberately bypassed — this is an ADMIN folder operation, not an article authorship
   * action. All mutations run in a single $transaction.
   *
   * Returns { deletedFolders, deletedArticles } — the root folder counts in deletedFolders.
   */
  async removeCascade(id: string): Promise<CascadeDeleteResult> {
    // 404 if the root folder doesn't exist or is already soft-deleted.
    await this.findOne(id);

    // BFS walk: collect all folder ids in the subtree (root + all descendants).
    // We query ALL children (including already-deleted ones) so we never miss alias rows that
    // reference a partially-deleted subtree, but we only count/stamp the LIVE ones.
    const subtreeIds = await this.collectSubtreeIds(id);
    const now = new Date();

    const [folderResult, articleResult] = await this.prisma.$transaction(
      async (tx) => {
        // 1. Hard-delete aliases whose home folder is in the subtree (folder-side aliases).
        await tx.articleAlias.deleteMany({
          where: { folderId: { in: subtreeIds } },
        });

        // 2. Soft-delete all live articles in the subtree (bypass author check — ADMIN op).
        const articlesUpdate = await tx.article.updateMany({
          where: {
            categoryId: { in: subtreeIds },
            deletedAt: null,
          },
          data: { deletedAt: now },
        });

        // 3. Hard-delete aliases whose article was just soft-deleted in step 2 (article-side
        //    aliases pointing to the deleted articles, in folders OUTSIDE this subtree).
        //    We gather the article ids first, then prune their remaining aliases.
        const deletedArticles = await tx.article.findMany({
          where: {
            categoryId: { in: subtreeIds },
            deletedAt: now,
          },
          select: { id: true },
        });
        if (deletedArticles.length > 0) {
          await tx.articleAlias.deleteMany({
            where: {
              articleId: { in: deletedArticles.map((a) => a.id) },
            },
          });
        }

        // 4. Soft-delete all live folders in the subtree (root + descendants).
        const foldersUpdate = await tx.articleCategory.updateMany({
          where: {
            id: { in: subtreeIds },
            deletedAt: null,
          },
          data: { deletedAt: now },
        });

        return [foldersUpdate, articlesUpdate] as const;
      },
    );

    return {
      deletedFolders: folderResult.count,
      deletedArticles: articleResult.count,
    };
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

  /**
   * BFS walk down the folder tree from `rootId` (inclusive). Returns all folder ids in the subtree
   * (the root + every descendant at every depth). Uses `includeSoftDeleted` so that already-deleted
   * branches don't block alias cleanup in a cascade operation.
   */
  private async collectSubtreeIds(rootId: string): Promise<string[]> {
    const ids: string[] = [rootId];
    const queue: string[] = [rootId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = await this.prisma.articleCategory.findMany({
        where: { parentId: current },
        select: { id: true },
        // Include soft-deleted children: a cascaded subtree may have been partially deleted
        // by a prior cascade; we still need their ids to clean up any orphan aliases.
        includeSoftDeleted: true,
      } as Prisma.ArticleCategoryFindManyArgs);

      for (const child of children) {
        ids.push(child.id);
        queue.push(child.id);
      }
    }

    return ids;
  }
}
