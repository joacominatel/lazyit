import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  offsetOf,
  pageOf,
  slugify,
  type ArticleStatus,
  type CreateArticle,
  type CreateArticleLink,
  type ImportArticle,
  type PageQuery,
  type UpdateArticle,
} from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import type { Article, User } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
import { SearchService } from '../search/search.service';
import { projectArticle, type ArticleRow } from '../search/search.documents';
import {
  maxImportBytes,
  maxImportMb,
  parseImportFile,
  titleFromFilename,
} from './article-import';

/** Listing filters for GET /articles. */
export interface ArticleListFilters {
  categoryId?: string;
  authorId?: string;
  status?: ArticleStatus;
  q?: string;
}

/** The subset of a multer file the import needs. The controller passes Express.Multer.File. */
export interface UploadedImportFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

// Lean projection for the LIST (GET /articles, paginated): every Article column EXCEPT `content` —
// the full Markdown body, the largest column, which a list view never renders (`excerpt` is kept).
// The detail reads (findOne / findBySlug) still return the full Article incl. `content`. See
// packages/shared/src/schemas/article-list.ts and ADR-0030 / the perf analysis (#3).
const ARTICLE_LIST_SELECT = {
  id: true,
  slug: true,
  title: true,
  excerpt: true,
  status: true,
  categoryId: true,
  authorId: true,
  lastEditedById: true,
  publishedAt: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} satisfies Prisma.ArticleSelect;

/**
 * Knowledge-base articles. Authorship/visibility (DRAFT private to its author; only the author may
 * write) is enforced here from the authenticated User (ADR-0038). The guard (JwtAuthGuard) already
 * validates the caller; services receive a `user?: User` and extract the id via ActorService. See
 * docs/03-decisions/0022-draft-visibility-auth-shim.md and docs/03-decisions/0038-jit-user-provisioning.md.
 */
@Injectable()
export class ArticlesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actor: ActorService,
    private readonly search: SearchService,
  ) {}

  /**
   * A single page of non-deleted articles, newest-updated first. PUBLISHED is visible to all; DRAFT
   * only to its author (the current user). Uses the LEAN projection ({@link ARTICLE_LIST_SELECT}):
   * the full Markdown `content` is omitted (`excerpt` kept) — the detail reads still return it. Runs
   * the page `findMany(take/skip)` and the `count` over the **same** `where` inside one
   * `$transaction`, so the `total` can't drift from the page. Optional filters: category, author,
   * status, and a substring `q` over title/excerpt.
   */
  async findPage(
    filters: ArticleListFilters,
    page: PageQuery,
    currentUser?: User,
  ) {
    const where = this.buildWhere(filters, currentUser);
    const { take, skip } = offsetOf(page);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.article.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take,
        skip,
        select: ARTICLE_LIST_SELECT,
      }),
      this.prisma.article.count({ where }),
    ]);
    // The lean rows carry `Date`s; the API serializes them to ISO strings at the HTTP boundary (same
    // as findOne) — the ArticleListPage DTO documents the resulting wire shape (content omitted).
    return pageOf(items, total, page);
  }

  /**
   * The shared `where` for the article list — used identically by findPage and its count. Combines
   * the visibility rule (PUBLISHED for all; the caller's own DRAFTs) with the optional filters.
   */
  private buildWhere(
    filters: ArticleListFilters,
    currentUser?: User,
  ): Prisma.ArticleWhereInput {
    const cu = this.resolveCurrentUser(currentUser);
    const and: Prisma.ArticleWhereInput[] = [this.visibilityWhere(cu)];
    if (filters.categoryId) and.push({ categoryId: filters.categoryId });
    if (filters.authorId) and.push({ authorId: filters.authorId });
    if (filters.status) and.push({ status: filters.status });
    if (filters.q) {
      and.push({
        OR: [
          { title: { contains: filters.q, mode: 'insensitive' } },
          { excerpt: { contains: filters.q, mode: 'insensitive' } },
        ],
      });
    }
    return { AND: and };
  }

  /** A readable article by id (404 if missing, deleted, or a draft the caller doesn't own). */
  async findOne(id: string, currentUser?: User) {
    const cu = this.resolveCurrentUser(currentUser);
    const article = await this.prisma.article.findFirst({
      where: { id },
    });
    if (!article || (article.status === 'DRAFT' && article.authorId !== cu)) {
      throw new NotFoundException(`Article ${id} not found`);
    }
    return article;
  }

  /** Same visibility rules as findOne, looked up by slug. */
  async findBySlug(slug: string, currentUser?: User) {
    const cu = this.resolveCurrentUser(currentUser);
    const article = await this.prisma.article.findFirst({
      where: { slug },
    });
    if (!article || (article.status === 'DRAFT' && article.authorId !== cu)) {
      throw new NotFoundException(`Article with slug "${slug}" not found`);
    }
    return article;
  }

  /**
   * Create. Author = the caller (current user), never the body. Slug autogenerated when omitted.
   * Snapshots version 1 in the same transaction (ADR-0042) so the article's full history starts at
   * creation — editing later never destroys the original body (ADR-0006).
   */
  async create(data: CreateArticle, currentUser?: User) {
    const authorId = this.requireCurrentUser(currentUser);
    await this.assertCategoryUsable(data.categoryId);
    const slug = data.slug ?? this.deriveSlug(data.title);
    const article = await this.prisma.$transaction(async (tx) => {
      const created = await tx.article.create({
        data: {
          slug,
          title: data.title,
          content: data.content,
          ...(data.excerpt !== undefined ? { excerpt: data.excerpt } : {}),
          status: data.status,
          publishedAt: data.status === 'PUBLISHED' ? new Date() : null,
          categoryId: data.categoryId,
          authorId,
          ...(data.metadata !== undefined
            ? { metadata: data.metadata as Prisma.InputJsonValue }
            : {}),
        },
      });
      // Version 1 — the initial snapshot. Same transaction so the article and its first version
      // commit atomically (ADR-0042).
      await this.snapshotVersion(tx, created, 1, authorId);
      return created;
    });
    // Index PUBLISHED only; a DRAFT is author-private (ADR-0022) so it must never be searchable —
    // a new DRAFT is simply not indexed (nothing to do).
    if (article.status === 'PUBLISHED') {
      this.search.upsert('articles', projectArticle(article));
    }
    return article;
  }

  /**
   * Partial update (author only). Records the editor; never changes status (use publish). When the
   * edit changes any versioned field (title/content/excerpt), it appends a new ArticleVersion in the
   * same transaction (ADR-0042) — so the prior body is preserved, not overwritten (ADR-0006). A
   * metadata-only or no-op edit does NOT create a version (status is never touched by PATCH).
   */
  async update(id: string, data: UpdateArticle, currentUser?: User) {
    const cu = this.requireCurrentUser(currentUser);
    const current = await this.loadOwned(id, cu);
    if (data.categoryId) await this.assertCategoryUsable(data.categoryId);
    const { metadata, ...rest } = data;
    const article = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.article.update({
        where: { id },
        data: {
          ...rest,
          lastEditedById: cu,
          ...(metadata !== undefined
            ? { metadata: metadata as Prisma.InputJsonValue }
            : {}),
        },
      });
      // Snapshot only when a versioned field actually changed (avoids a noise version on a
      // metadata-only or idempotent PATCH). status is never changed here (publish/unpublish do that).
      if (this.versionedFieldsChanged(current, updated)) {
        await this.snapshotVersion(
          tx,
          updated,
          await this.nextVersion(tx, id),
          cu,
        );
      }
      return updated;
    });
    // update never changes status (publish/unpublish do), but re-sync defensively: upsert if the
    // result is PUBLISHED, else remove — keeps the index honest about draft privacy (ADR-0035).
    this.syncSearch(article);
    return article;
  }

  /** Soft delete (author only). */
  async remove(id: string, currentUser?: User) {
    const cu = this.requireCurrentUser(currentUser);
    await this.loadOwned(id, cu);
    const article = await this.prisma.article.update({
      where: { id },
      data: { deletedAt: new Date(), lastEditedById: cu },
    });
    // Drop from the index so soft-deleted articles never surface in search (ADR-0035).
    this.search.remove('articles', id);
    return article;
  }

  /**
   * Restore a soft-deleted article: clear `deletedAt` (ADR-0041). The route is ADMIN-gated, but
   * authorship still governs WHICH article an actor may restore (mirroring remove): only the original
   * author may restore their own article. Found via the `includeSoftDeleted` escape hatch (the read
   * filter would hide it). 404 if it never existed; 403 if owned by someone else; idempotent if
   * already live. The partial unique index frees `slug` on delete, so a restore can 409 if another
   * live article took the slug (mapped by the global PrismaExceptionFilter). On success the article is
   * re-indexed only if PUBLISHED (draft privacy — ADR-0022 / ADR-0035).
   */
  async restore(id: string, currentUser?: User) {
    const cu = this.requireCurrentUser(currentUser);
    const article = await this.prisma.article.findFirst({
      where: { id },
      includeSoftDeleted: true,
    } as Prisma.ArticleFindFirstArgs);
    if (!article) {
      throw new NotFoundException(`Article ${id} not found`);
    }
    if (article.authorId !== cu) {
      throw new ForbiddenException('Only the author can restore this article');
    }
    if (article.deletedAt === null) {
      return article; // already live — idempotent
    }
    const restored = await this.prisma.article.update({
      where: { id },
      data: { deletedAt: null, lastEditedById: cu },
    });
    // Re-index honoring draft privacy: PUBLISHED is indexed, a DRAFT stays out (ADR-0022 / ADR-0035).
    this.syncSearch(restored);
    return restored;
  }

  /**
   * Publish (author only). Sets publishedAt on the first publish; idempotent if already published.
   * A real transition (DRAFT → PUBLISHED) changes `status`, so it snapshots a new version in the
   * same transaction (ADR-0042); the idempotent no-op does not.
   */
  async publish(id: string, currentUser?: User) {
    const cu = this.requireCurrentUser(currentUser);
    const article = await this.loadOwned(id, cu);
    if (article.status === 'PUBLISHED') return article;
    const published = await this.prisma.$transaction(async (tx) => {
      const next = await tx.article.update({
        where: { id },
        data: {
          status: 'PUBLISHED',
          publishedAt: article.publishedAt ?? new Date(),
          lastEditedById: cu,
        },
      });
      await this.snapshotVersion(tx, next, await this.nextVersion(tx, id), cu);
      return next;
    });
    // Now searchable (ADR-0035).
    this.search.upsert('articles', projectArticle(published));
    return published;
  }

  /**
   * Unpublish back to DRAFT (author only). Keeps publishedAt ("was published once"). A real
   * transition (PUBLISHED → DRAFT) changes `status`, so it snapshots a new version in the same
   * transaction (ADR-0042); the idempotent no-op does not.
   */
  async unpublish(id: string, currentUser?: User) {
    const cu = this.requireCurrentUser(currentUser);
    const article = await this.loadOwned(id, cu);
    if (article.status === 'DRAFT') return article;
    const unpublished = await this.prisma.$transaction(async (tx) => {
      const next = await tx.article.update({
        where: { id },
        data: { status: 'DRAFT', lastEditedById: cu },
      });
      await this.snapshotVersion(tx, next, await this.nextVersion(tx, id), cu);
      return next;
    });
    // Back to author-private — drop from the index (ADR-0035).
    this.search.remove('articles', id);
    return unpublished;
  }

  /** Import an article from an uploaded .md/.txt/.docx file. Author = caller. */
  async importArticle(
    file: UploadedImportFile | undefined,
    fields: ImportArticle,
    currentUser?: User,
  ) {
    const authorId = this.requireCurrentUser(currentUser);
    if (!file) {
      throw new BadRequestException('A file is required');
    }
    if (file.size > maxImportBytes()) {
      throw new BadRequestException(
        `File exceeds the ${maxImportMb()} MB import limit`,
      );
    }
    await this.assertCategoryUsable(fields.categoryId);
    const content = await parseImportFile({
      originalname: file.originalname,
      buffer: file.buffer,
    });
    if (!content.trim()) {
      throw new BadRequestException('The imported file has no text content');
    }
    const title = fields.title ?? titleFromFilename(file.originalname);
    const slug = fields.slug ?? this.deriveSlug(title);
    const article = await this.prisma.$transaction(async (tx) => {
      const created = await tx.article.create({
        data: {
          slug,
          title,
          content,
          status: fields.status,
          publishedAt: fields.status === 'PUBLISHED' ? new Date() : null,
          categoryId: fields.categoryId,
          authorId,
        },
      });
      // An import is a create — version 1 (ADR-0042).
      await this.snapshotVersion(tx, created, 1, authorId);
      return created;
    });
    // Same draft-privacy rule as create(): index PUBLISHED only (ADR-0022 / ADR-0035).
    if (article.status === 'PUBLISHED') {
      this.search.upsert('articles', projectArticle(article));
    }
    return article;
  }

  // --- versions (append-only edit history, ADR-0042) -----------------------

  /**
   * A page of an article's version history, newest version first (ADR-0030/0042). Visibility
   * mirrors the article reads: a DRAFT's history is only visible to its author (404 otherwise), so
   * snapshots never leak a private draft's content. Runs the page `findMany(take/skip)` and the
   * `count` over the same `where` inside one `$transaction` so `total` can't drift from the page.
   */
  async listVersions(articleId: string, page: PageQuery, currentUser?: User) {
    // Reuse findOne's visibility gate (404 if missing, soft-deleted, or a draft the caller can't see).
    await this.findOne(articleId, currentUser);
    const { take, skip } = offsetOf(page);
    const where: Prisma.ArticleVersionWhereInput = { articleId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.articleVersion.findMany({
        where,
        orderBy: { version: 'desc' },
        take,
        skip,
      }),
      this.prisma.articleVersion.count({ where }),
    ]);
    return pageOf(items, total, page);
  }

  /**
   * A single version of an article by its per-article version number (404 if the article is not
   * readable by the caller, or that version doesn't exist). Same visibility gate as {@link listVersions}.
   */
  async findVersion(articleId: string, version: number, currentUser?: User) {
    await this.findOne(articleId, currentUser);
    const snapshot = await this.prisma.articleVersion.findFirst({
      where: { articleId, version },
    });
    if (!snapshot) {
      throw new NotFoundException(
        `Version ${version} of article ${articleId} not found`,
      );
    }
    return snapshot;
  }

  // --- links (article <-> asset/application, ADR-0042) ---------------------

  /**
   * Link an article to an Asset XOR an Application (ADR-0042). The caller must be able to write the
   * article (author-only, same gate as edits). Exactly-one-target is validated at the edge (zod) and
   * guaranteed by a DB CHECK; the target must reference a live (non-soft-deleted) row, and a
   * duplicate link (same article+target) is rejected (409 via the partial unique index, mapped by
   * the global PrismaExceptionFilter).
   */
  async addLink(
    articleId: string,
    data: CreateArticleLink,
    currentUser?: User,
  ) {
    const cu = this.requireCurrentUser(currentUser);
    await this.loadOwned(articleId, cu);
    if (data.assetId) {
      await this.assertAssetUsable(data.assetId);
    } else if (data.applicationId) {
      await this.assertApplicationUsable(data.applicationId);
    }
    return this.prisma.articleLink.create({
      data: {
        articleId,
        assetId: data.assetId ?? null,
        applicationId: data.applicationId ?? null,
        createdById: cu,
      },
    });
  }

  /**
   * Remove a link from an article (ADR-0042). Author-only (same gate as edits). 404 if the link
   * doesn't exist or doesn't belong to this article (so an actor can't probe another article's links).
   */
  async removeLink(articleId: string, linkId: string, currentUser?: User) {
    const cu = this.requireCurrentUser(currentUser);
    await this.loadOwned(articleId, cu);
    const link = await this.prisma.articleLink.findFirst({
      where: { id: linkId, articleId },
    });
    if (!link) {
      throw new NotFoundException(
        `Link ${linkId} not found on article ${articleId}`,
      );
    }
    return this.prisma.articleLink.delete({ where: { id: link.id } });
  }

  /** All links of an article (readable by any caller who can read the article). */
  async findLinks(articleId: string, currentUser?: User) {
    await this.findOne(articleId, currentUser);
    return this.prisma.articleLink.findMany({
      where: { articleId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Reverse lookup: the PUBLISHED articles linked to a given asset (`GET /assets/:id/articles`).
   * DRAFTs are excluded (a draft is author-private; this list is asset-scoped, not author-scoped, so
   * it only ever exposes team-visible articles). Returns the lean article list shape (no content).
   */
  async findArticlesForAsset(assetId: string) {
    return this.prisma.article.findMany({
      where: { status: 'PUBLISHED', links: { some: { assetId } } },
      orderBy: { updatedAt: 'desc' },
      select: ARTICLE_LIST_SELECT,
    });
  }

  /**
   * Reverse lookup: the PUBLISHED articles linked to a given application
   * (`GET /applications/:id/articles` — "the runbook for THIS app"). Mirrors
   * {@link findArticlesForAsset}: DRAFTs are excluded (a draft is author-private; this list is
   * application-scoped, not author-scoped), and it returns the lean article list shape (no content).
   */
  async findArticlesForApplication(applicationId: string) {
    return this.prisma.article.findMany({
      where: { status: 'PUBLISHED', links: { some: { applicationId } } },
      orderBy: { updatedAt: 'desc' },
      select: ARTICLE_LIST_SELECT,
    });
  }

  // --- internals -----------------------------------------------------------

  /**
   * Fire-and-forget search sync that honors draft privacy (ADR-0022 / ADR-0035): a PUBLISHED article
   * is indexed (upsert), anything else (DRAFT) is removed — so DRAFTs are never searchable and an
   * article edited while not PUBLISHED is dropped. Un-awaited, never throws, no-op when disabled.
   * Used by update(), whose result may be PUBLISHED or DRAFT.
   */
  private syncSearch(article: ArticleRow): void {
    if (article.status === 'PUBLISHED') {
      this.search.upsert('articles', projectArticle(article));
    } else {
      this.search.remove('articles', article.id);
    }
  }

  /** PUBLISHED for everyone; plus the caller's own DRAFTs when there is a current user. */
  private visibilityWhere(currentUserId?: string): Prisma.ArticleWhereInput {
    return currentUserId
      ? {
          OR: [
            { status: 'PUBLISHED' },
            { status: 'DRAFT', authorId: currentUserId },
          ],
        }
      : { status: 'PUBLISHED' };
  }

  /**
   * Load an article for a write and enforce author-only: 404 if missing or a draft the caller can't
   * see (hides existence), 403 if it's a published article owned by someone else.
   */
  private async loadOwned(id: string, currentUserId: string) {
    const article = await this.prisma.article.findFirst({
      where: { id },
    });
    if (!article) {
      throw new NotFoundException(`Article ${id} not found`);
    }
    if (article.status === 'DRAFT' && article.authorId !== currentUserId) {
      throw new NotFoundException(`Article ${id} not found`);
    }
    if (article.authorId !== currentUserId) {
      throw new ForbiddenException('Only the author can modify this article');
    }
    return article;
  }

  /**
   * Extract the id of the current user (or undefined for anonymous). Delegates to ActorService
   * which simply returns user?.id (the guard already validated the user — ADR-0038).
   */
  private resolveCurrentUser(currentUser?: User): string | undefined {
    return this.actor.resolve(currentUser);
  }

  /**
   * Like resolveCurrentUser but mandatory (writes): 400 if no authenticated user is present.
   * In OIDC mode the guard already ensures a user is set, so this only fires in shim mode when
   * X-User-Id is absent.
   */
  private requireCurrentUser(currentUser?: User): string {
    const resolved = this.resolveCurrentUser(currentUser);
    if (!resolved) {
      throw new BadRequestException(
        'An authenticated user is required for this operation',
      );
    }
    return resolved;
  }

  private deriveSlug(title: string): string {
    const slug = slugify(title);
    if (!slug) {
      throw new BadRequestException(
        'Could not derive a slug from the title; provide an explicit slug',
      );
    }
    return slug;
  }

  /** 400 if categoryId doesn't reference a live (non-soft-deleted) category. */
  private async assertCategoryUsable(categoryId: string): Promise<void> {
    const category = await this.prisma.articleCategory.findFirst({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!category) {
      throw new BadRequestException(
        `categoryId ${categoryId} does not reference a live category`,
      );
    }
  }

  /** 400 if assetId doesn't reference a live (non-soft-deleted) asset (ADR-0042 linking). */
  private async assertAssetUsable(assetId: string): Promise<void> {
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId },
      select: { id: true },
    });
    if (!asset) {
      throw new BadRequestException(
        `assetId ${assetId} does not reference a live asset`,
      );
    }
  }

  /** 400 if applicationId doesn't reference a live (non-soft-deleted) application (ADR-0042). */
  private async assertApplicationUsable(applicationId: string): Promise<void> {
    const application = await this.prisma.application.findFirst({
      where: { id: applicationId },
      select: { id: true },
    });
    if (!application) {
      throw new BadRequestException(
        `applicationId ${applicationId} does not reference a live application`,
      );
    }
  }

  /**
   * True when an edit changed any field captured by an ArticleVersion snapshot: title, content,
   * excerpt or status (ADR-0042). Used by update() to avoid a noise version on a metadata-only or
   * idempotent PATCH.
   */
  private versionedFieldsChanged(before: Article, after: Article): boolean {
    return (
      before.title !== after.title ||
      before.content !== after.content ||
      before.excerpt !== after.excerpt ||
      before.status !== after.status
    );
  }

  /**
   * The next per-article version number (max(version)+1, or 1 for the first). Computed inside the
   * same transaction as the article write so the snapshot stays consistent; the `@@unique(articleId,
   * version)` is the hard guarantee against a concurrent double-allocation (the backend write path is
   * effectively serial — ADR-0042).
   */
  private async nextVersion(
    tx: Prisma.TransactionClient,
    articleId: string,
  ): Promise<number> {
    const agg = await tx.articleVersion.aggregate({
      where: { articleId },
      _max: { version: true },
    });
    return (agg._max.version ?? 0) + 1;
  }

  /**
   * Append an ArticleVersion snapshot of an article's editable state (ADR-0042). Append-only: a
   * version is written once and never updated/deleted. `editedById` is the actor (creator/editor);
   * null if unknown. Always called inside the transaction that wrote the article so the two commit
   * atomically.
   */
  private async snapshotVersion(
    tx: Prisma.TransactionClient,
    article: Article,
    version: number,
    editedById: string | null,
  ): Promise<void> {
    await tx.articleVersion.create({
      data: {
        articleId: article.id,
        version,
        title: article.title,
        content: article.content,
        excerpt: article.excerpt,
        status: article.status,
        editedById,
      },
    });
  }
}
