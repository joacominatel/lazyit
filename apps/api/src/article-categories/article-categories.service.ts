import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { isServicePrincipal, type Principal } from '../auth/principal';
import { SearchService } from '../search/search.service';
import {
  FolderAccessService,
  folderVisible,
  type FolderTreeCache,
  type VisibleFolders,
} from './folder-access.service';
import {
  expandFolderSubtrees,
  FOLDER_TREE_LOCK,
  rollUpFolderCounts,
  type FolderTreeEdge,
} from './folder-tree';

/** Shape returned by a successful cascade delete. */
export interface CascadeDeleteResult {
  /** Total folders soft-deleted (the root + every descendant). */
  deletedFolders: number;
  /** Total articles soft-deleted across the whole subtree. */
  deletedArticles: number;
}

/**
 * The non-sensitive ArticleCategory columns — every field of the row EXCEPT `accessRules` (ADR-0060 §3:
 * the per-folder permission boundary — allowed user UUIDs + the gating role/applicationId/assetId). A
 * folder's access rule is an AUTHORIZATION-management surface; it must NOT be returned to an ordinary
 * `category:read` caller (which is default-open and includes VIEWER), only to a `settings:manage`
 * holder — the same gate that WRITES it (INV-9 / #554). The default read uses this explicit select so
 * `accessRules` is never even fetched; the rule-editor read path re-includes it on top.
 *
 * The derived `hasAccessRules` flag (#1299) does NOT change that: it resolves through
 * `FolderAccessService`, which already loads the tree's rules for the §4 evaluation, so the raw jsonb
 * still never rides along on this query's result.
 */
const CATEGORY_PUBLIC_SELECT = {
  id: true,
  name: true,
  description: true,
  icon: true,
  order: true,
  parentId: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} satisfies Prisma.ArticleCategorySelect;

const FOLDER_MOVE_FORBIDDEN =
  'Moving a folder changes who can read its articles and requires the settings:manage permission';

/**
 * Folders (ADR-0059 §1) — the hierarchical evolution of the flat ArticleCategory. The model/table
 * stay `ArticleCategory` / `article_categories` and the endpoints stay `/article-categories` (the
 * rename to Folder/folders is a deliberate follow-up); this service gains the tree semantics: a
 * `parentId` self-FK, a cycle guard (a folder may not be its own ancestor) and a no-silent-orphan
 * delete (a folder with live CHILD folders is a 409, mirroring the existing live-articles 409). No
 * access semantics live here — ADR-0060 attaches the per-folder permission boundary later.
 */
@Injectable()
export class ArticleCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionResolverService,
    // Fire-and-forget Meili sync (#595): resolved from the @Global SearchModule. Used to DEINDEX the
    // articles a cascade soft-deletes, mirroring the single-article ArticlesService.remove() path so a
    // cascade never leaves ghost docs in the search index. ArticleCategoriesService is not a dependency
    // of SearchService, so there is no provider cycle despite SearchModule importing this module.
    private readonly search: SearchService,
    // Folder-access evaluator (ADR-0060 §4). The list endpoint uses it so the per-folder `articleCount`
    // (#1106 Phase 4) is null for a folder the caller cannot read — the count must never reveal more
    // than the article list would show that viewer, and (#1299) so the derived `hasAccessRules` flag
    // reuses the evaluator's OWN public-vs-restricted resolution rather than a second definition of it.
    // Provided by this same module (no new dependency).
    private readonly folderAccess: FolderAccessService,
  ) {}

  /**
   * All non-deleted categories, ordered by `order` (nulls last) then name. `accessRules` (the folder's
   * permission boundary — ADR-0060 §3) is INCLUDED only for a caller holding `settings:manage` (the
   * web rule-editor); for an ordinary `category:read` caller it is omitted entirely (INV-9 / #554). The
   * internal mutation callers pass no principal → they receive the public shape (and discard it).
   *
   * Each row also carries a COMPUTED `articleCount` (#1106 Phase 4) — a Prisma `_count` over the
   * articles relation, NOT a stored column (no migration). The count is scoped to exactly what the
   * article LIST would show this caller: LIVE (`deletedAt: null`) articles that are PUBLISHED, plus the
   * caller's OWN DRAFTs (the article list's `visibilityWhere`) — so it never leaks the existence of
   * other authors' drafts. AUTHZ (ADR-0060 §4): the count is set to `null` for any folder the caller
   * cannot READ, so it never reveals a count of articles inside a folder the list itself hides from
   * them. The nested relation count is filtered explicitly (`deletedAt: null`) because the soft-delete
   * read extension only scopes TOP-LEVEL queries, not nested `_count` relation filters.
   *
   * `totalArticleCount` (#1651) sums that count over the folder and its live descendants, and is `null`
   * exactly where `articleCount` is.
   *
   * Each row also carries the derived `hasAccessRules` flag (#1299, ADR-0060 §3 carve-out): whether the
   * folder CARRIES a restriction — never who it lets in, nor what the rule is. It is readable by ANY
   * `category:read` caller (VIEWER included) so the web can warn that moving an article into or out of
   * a restricted folder changes its audience (§9); the rules themselves stay `settings:manage`-gated.
   */
  async findAll(principal?: Principal) {
    const withRules = await this.canSeeAccessRules(principal);
    // One request-scoped folder-tree load shared by both folder-access lookups below (#599): the tree
    // is read once and answers both questions, so `hasAccessRules` costs a non-admin NO extra query.
    // An ADMIN short-circuits `visibleFolderIds` to 'ALL' without loading the tree, so for them the
    // flag adds exactly one folder scan — the same scan every non-admin read already pays.
    const tree: FolderTreeCache = {};
    // Which folders may this caller read (ADR-0060 §4)? ADMIN → 'ALL' (every count shown); a non-admin
    // gets the explicit visible set; a no-principal internal caller fails closed to public folders.
    const visible = await this.folderAccess.visibleFolderIds(principal, tree);
    // Which folders CARRY a restriction (§3) — a property of the folder, not of the caller. Exposed to
    // every `category:read` reader as the derived `hasAccessRules` flag (#1299).
    const restricted = await this.folderAccess.restrictedFolderIds(tree);
    const rows = await this.prisma.articleCategory.findMany({
      orderBy: [{ order: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
      select: {
        ...CATEGORY_PUBLIC_SELECT,
        ...(withRules ? { accessRules: true } : {}),
        _count: {
          select: {
            articles: { where: this.articleCountWhere(principal) },
          },
        },
      },
    });
    // A folder the caller can't read adds nothing to its ancestors' totals (#1651), so a restricted
    // subfolder never shows through its parent's number.
    const totals = rollUpFolderCounts(
      rows,
      new Map(
        rows.map((row) => [
          row.id,
          folderVisible(visible, row.id) ? row._count.articles : 0,
        ]),
      ),
    );
    // Flatten Prisma's nested `_count.articles` into the flat `articleCount` the DTO exposes, and null
    // it out for a folder the caller can't read (don't leak a hidden folder's article count — §4).
    return rows.map(({ _count, ...row }) => {
      const readable = folderVisible(visible, row.id);
      return {
        ...row,
        articleCount: readable ? _count.articles : null,
        totalArticleCount: readable ? (totals.get(row.id) ?? 0) : null,
        hasAccessRules: restricted.has(row.id),
      };
    });
  }

  /**
   * The nested-relation `_count` filter for a folder's `articleCount` (#1106 Phase 4). Mirrors the
   * article list's own visibility (ArticlesService `visibilityWhere`): LIVE + PUBLISHED for everyone,
   * plus the caller's OWN DRAFTs — so a folder's number equals the count of rows the caller would find
   * in that folder via the list, never more. `deletedAt: null` is explicit here (the soft-delete
   * extension does not reach nested relation filters). A service account / anonymous caller (no human
   * id) sees PUBLISHED-only, matching the list.
   */
  private articleCountWhere(principal?: Principal): Prisma.ArticleWhereInput {
    const currentUserId =
      principal !== undefined && !isServicePrincipal(principal)
        ? principal.user.id
        : undefined;
    return {
      deletedAt: null,
      ...(currentUserId
        ? {
            OR: [
              { status: 'PUBLISHED' },
              { status: 'DRAFT', authorId: currentUserId },
            ],
          }
        : { status: 'PUBLISHED' }),
    };
  }

  /**
   * A single non-deleted category by id; throws 404 if missing or deleted. `accessRules` is included
   * only for a `settings:manage` caller (the rule-editor), omitted otherwise (INV-9 / #554) — same gate
   * as {@link findAll}. Mutation methods call this for the 404 guard with no principal and discard the
   * (public-shaped) return.
   *
   * A read made by a real caller also carries the derived `hasAccessRules` flag (#1299), same meaning
   * as in {@link findAll}. It is skipped for the no-principal internal callers, which discard the row.
   */
  async findOne(id: string, principal?: Principal) {
    const withRules = await this.canSeeAccessRules(principal);
    const category = await this.prisma.articleCategory.findFirst({
      where: { id },
      select: {
        ...CATEGORY_PUBLIC_SELECT,
        ...(withRules ? { accessRules: true } : {}),
      },
    });
    if (!category) {
      throw new NotFoundException(`ArticleCategory ${id} not found`);
    }
    // The derived `hasAccessRules` flag (#1299) — same shape as the list, so a folder read answers the
    // same question whichever endpoint asked it. Only for a real HTTP caller: the internal mutation
    // callers below pass NO principal and discard this row, and they must not pay a folder-tree load.
    if (principal === undefined) {
      return category;
    }
    const restricted = await this.folderAccess.restrictedFolderIds();
    return { ...category, hasAccessRules: restricted.has(category.id) };
  }

  /**
   * Whether the caller may see a folder's `accessRules` on a read — i.e. holds `settings:manage` (the
   * SAME gate that writes it via PUT :id/access-rules, ADR-0060 §3, and that moves a folder, §10).
   * Resolved DB-first, never from a token (INV-1 / INV-8): a human's role → the RolePermission matrix
   * (ADMIN always full); a service account → its direct permission grants. Anonymous / no principal → false (fail closed).
   */
  private async canSeeAccessRules(principal?: Principal): Promise<boolean> {
    if (principal === undefined) return false;
    if (isServicePrincipal(principal)) {
      return principal.permissions.has('settings:manage');
    }
    return this.permissions.hasAll(principal.user.role, ['settings:manage']);
  }

  /** A new folder inherits its parent's rule, so it needs only read access to the parent (ADR-0060 §10). */
  async create(data: CreateArticleCategory, principal?: Principal) {
    const { parentId } = data;
    if (parentId === undefined) {
      return this.prisma.articleCategory.create({
        data,
        select: CATEGORY_PUBLIC_SELECT,
      });
    }
    const visible = await this.folderAccess.visibleFolderIds(principal);
    return this.prisma.$transaction(async (tx) => {
      await this.lockFolderTree(tx);
      await this.assertParentUsable(tx, parentId, visible);
      return tx.articleCategory.create({
        data,
        select: CATEGORY_PUBLIC_SELECT,
      });
    });
  }

  /** A changed `parentId` re-scopes who reads the subtree: a `settings:manage` write (ADR-0060 §10). */
  async update(id: string, data: UpdateArticleCategory, principal?: Principal) {
    const { parentId } = data;
    if (parentId === undefined) {
      await this.findOne(id); // 404 if missing or already soft-deleted
      return this.prisma.articleCategory.update({
        where: { id },
        data,
        select: CATEGORY_PUBLIC_SELECT,
      });
    }
    return this.prisma.$transaction(async (tx) => {
      await this.lockFolderTree(tx);
      const current = await this.loadLiveFolder(tx, id);
      // Repeating the current parent is not a move; gating it would break a rename that echoes it.
      if (current.parentId === parentId) {
        return tx.articleCategory.update({
          where: { id },
          data,
          select: CATEGORY_PUBLIC_SELECT,
        });
      }
      if (!(await this.canSeeAccessRules(principal))) {
        throw new ForbiddenException(FOLDER_MOVE_FORBIDDEN);
      }
      if (parentId !== null) {
        await this.assertParentUsable(tx, parentId);
        await this.assertNoFolderCycle(tx, id, parentId);
      }
      const moved = await tx.articleCategory.update({
        where: { id },
        data,
        select: CATEGORY_PUBLIC_SELECT,
      });
      await this.recordFolderMove(tx, id, principal);
      return moved;
    });
  }

  /** ADR-0060 §10: the §9 article-move record, written for every live article in the moved subtree. */
  private async recordFolderMove(
    tx: Prisma.TransactionClient,
    folderId: string,
    principal?: Principal,
  ): Promise<void> {
    const subtree = expandFolderSubtrees(
      [folderId],
      await this.loadFolderEdges(tx),
    );
    // Blocks concurrent version writers; NO KEY UPDATE, not UPDATE, so FK inserts' KEY SHARE cannot deadlock.
    await tx.$queryRaw`SELECT "id" FROM "articles" WHERE "categoryId" = ANY(${subtree}::text[]) AND "deletedAt" IS NULL ORDER BY "id" FOR NO KEY UPDATE`;
    const articles = await tx.article.findMany({
      where: { categoryId: { in: subtree }, deletedAt: null },
      select: {
        id: true,
        title: true,
        content: true,
        excerpt: true,
        status: true,
      },
    });
    if (articles.length === 0) return;
    const latest = await tx.articleVersion.groupBy({
      by: ['articleId'],
      where: { articleId: { in: articles.map((a) => a.id) } },
      _max: { version: true },
    });
    const lastVersion = new Map(
      latest.map((row) => [row.articleId, row._max.version ?? 0]),
    );
    const actor = isServicePrincipal(principal)
      ? { serviceAccountId: principal.serviceAccount.id }
      : { editedById: principal?.user.id ?? null };
    await tx.articleVersion.createMany({
      data: articles.map((article) => ({
        articleId: article.id,
        version: (lastVersion.get(article.id) ?? 0) + 1,
        title: article.title,
        content: article.content,
        excerpt: article.excerpt,
        status: article.status,
        ...actor,
      })),
    });
  }

  /**
   * Soft delete. Refuses with 409 if the folder still has live articles (the home-folder FK can't be
   * orphaned — reassign/delete those articles first) OR live CHILD folders (a non-empty subtree is
   * never silently orphaned — ADR-0059 §1; reparent/delete the children first). Both guards are
   * application logic: our delete is a soft delete (UPDATE deletedAt) which does not fire the FK's
   * referential action — the schema FKs are only hard-delete safety nets. See ADR-0021 / ADR-0019.
   */
  async remove(id: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockFolderTree(tx);
      await this.lockFolderRows(tx, [id]);
      await this.loadLiveFolder(tx, id);
      const liveArticles = await tx.article.count({
        where: { categoryId: id, deletedAt: null },
      });
      if (liveArticles > 0) {
        throw new ConflictException(
          `Cannot delete folder: ${liveArticles} article(s) still use it. Move or delete them first.`,
        );
      }
      const liveChildren = await tx.articleCategory.count({
        where: { parentId: id, deletedAt: null },
      });
      if (liveChildren > 0) {
        throw new ConflictException(
          `Cannot delete folder: ${liveChildren} sub-folder(s) still nest under it. Move or delete them first.`,
        );
      }
      return tx.articleCategory.update({
        where: { id },
        data: { deletedAt: new Date() },
        select: CATEGORY_PUBLIC_SELECT,
      });
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
   * action. The subtree walk and all mutations run in a single $transaction under the folder-tree lock.
   *
   * Returns { deletedFolders, deletedArticles } — the root folder counts in deletedFolders.
   */
  async removeCascade(id: string): Promise<CascadeDeleteResult> {
    const now = new Date();

    const [folderResult, articleResult, deletedArticleIds] =
      await this.prisma.$transaction(async (tx) => {
        await this.lockFolderTree(tx);
        // 404 if the root folder doesn't exist or is already soft-deleted.
        await this.loadLiveFolder(tx, id);

        // Soft-deleted branches too: their aliases still need cleaning up.
        const subtreeIds = expandFolderSubtrees(
          [id],
          await this.loadFolderEdges(tx),
        );
        await this.lockFolderRows(tx, subtreeIds);

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

        return [
          foldersUpdate,
          articlesUpdate,
          deletedArticles.map((a) => a.id),
        ] as const;
      });

    // #595: deindex the cascade-soft-deleted articles from Meili AFTER the tx commits, fire-and-forget
    // and un-awaited — mirroring the single-article ArticlesService.remove() path. Without this, a
    // cascade leaves PUBLISHED docs as ghost hits in the `articles` index until a manual reindex:all
    // (the search backstop is folder-access only, not soft-delete aware). SearchService.remove never
    // throws (it logs on failure), so a search outage can never fail the already-committed delete.
    for (const articleId of deletedArticleIds) {
      this.search.remove('articles', articleId);
    }

    return {
      deletedFolders: folderResult.count,
      deletedArticles: articleResult.count,
    };
  }

  /**
   * Restore a soft-deleted category: clear `deletedAt` (ADR-0041). Found via the `includeSoftDeleted`
   * escape hatch (the read filter would hide it). 404 if it never existed; idempotent if already
   * live. The partial unique index frees `name` on delete, so a restore can 409 if another live
   * category took the name in the meantime (mapped by the global PrismaExceptionFilter). A sub-folder
   * whose parent is still deleted is a 409: restore the parent first.
   */
  async restore(id: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockFolderTree(tx);
      const category = await tx.articleCategory.findFirst({
        where: { id },
        select: CATEGORY_PUBLIC_SELECT,
        includeSoftDeleted: true,
      } as Prisma.ArticleCategoryFindFirstArgs);
      if (!category) {
        throw new NotFoundException(`ArticleCategory ${id} not found`);
      }
      if (category.deletedAt === null) {
        return category; // already live — idempotent
      }
      if (
        category.parentId !== null &&
        !(await this.isLiveFolder(tx, category.parentId))
      ) {
        throw new ConflictException(
          'Cannot restore folder: its parent folder is deleted. Restore the parent first.',
        );
      }
      return tx.articleCategory.update({
        where: { id },
        data: { deletedAt: null },
        select: CATEGORY_PUBLIC_SELECT,
      });
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
      // No write echoes the rules (#1301); the editor re-reads them through the gated GET.
      select: CATEGORY_PUBLIC_SELECT,
    });
  }

  // --- folder hierarchy guards (ADR-0059 §1) --------------------------------

  private async lockFolderTree(tx: Prisma.TransactionClient): Promise<void> {
    // $executeRaw: pg_advisory_xact_lock returns void, which Prisma's pg driver cannot deserialize.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${FOLDER_TREE_LOCK}))`;
  }

  // FOR UPDATE blocks on the FK's KEY SHARE, so an in-flight article insert commits first and gets counted.
  private async lockFolderRows(
    tx: Prisma.TransactionClient,
    ids: readonly string[],
  ): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "article_categories" WHERE "id" = ANY(${ids}::text[]) ORDER BY "id" FOR UPDATE`;
  }

  private async isLiveFolder(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<boolean> {
    const folder = await tx.articleCategory.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    return folder !== null;
  }

  /** 404 if the folder is missing or soft-deleted. */
  private async loadLiveFolder(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<{ id: string; parentId: string | null }> {
    const folder = await tx.articleCategory.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, parentId: true },
    });
    if (!folder) {
      throw new NotFoundException(`ArticleCategory ${id} not found`);
    }
    return folder;
  }

  /** 400 if parentId isn't a live folder, or (given `visible`) one the caller can't read — the same 400. */
  private async assertParentUsable(
    tx: Prisma.TransactionClient,
    parentId: string,
    visible?: VisibleFolders,
  ): Promise<void> {
    if (
      (visible !== undefined && !folderVisible(visible, parentId)) ||
      !(await this.isLiveFolder(tx, parentId))
    ) {
      throw new BadRequestException(
        `parentId ${parentId} does not reference a live folder`,
      );
    }
  }

  /**
   * Reject a reparent that would make `subjectId` its own ancestor (a cycle — 400): the proposed parent
   * sits in the subject's subtree. Soft-deleted folders count, or a later restore could close the loop.
   */
  private async assertNoFolderCycle(
    tx: Prisma.TransactionClient,
    subjectId: string,
    proposedParentId: string,
  ): Promise<void> {
    if (proposedParentId === subjectId) {
      throw new BadRequestException('A folder cannot be its own parent');
    }
    const subtree = expandFolderSubtrees(
      [subjectId],
      await this.loadFolderEdges(tx),
    );
    if (subtree.includes(proposedParentId)) {
      throw new BadRequestException(
        'Moving this folder there would create a folder cycle',
      );
    }
  }

  /** Every folder's `(id, parentId)` edge, soft-deleted folders included. */
  private async loadFolderEdges(
    tx: Prisma.TransactionClient,
  ): Promise<FolderTreeEdge[]> {
    return tx.articleCategory.findMany({
      select: { id: true, parentId: true },
      includeSoftDeleted: true,
    } as Prisma.ArticleCategoryFindManyArgs);
  }
}
