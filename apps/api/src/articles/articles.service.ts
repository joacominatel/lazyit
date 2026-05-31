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
  type ImportArticle,
  type PageQuery,
  type UpdateArticle,
} from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
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

// Lean projection for the LIST (GET /articles): every Article column EXCEPT `content` (the full
// markdown body, arbitrarily large — shipping it for every row is the unbounded payload SEC-007 /
// ADR-0030 warn about). The list keeps `excerpt` (the rendered summary); the body is fetched on
// demand via GET /articles/:id (or by-slug). Mirrors ArticleListItemSchema in @lazyit/shared.
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

/** The subset of a multer file the import needs. The controller passes Express.Multer.File. */
export interface UploadedImportFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

/**
 * Knowledge-base articles. Authorship/visibility (DRAFT private to its author; only the author may
 * write) is enforced here from the X-User-Id shim, resolved through the shared {@link ActorService} —
 * when real auth lands, `currentUserId` comes from the JWT and these methods are unchanged. See
 * docs/03-decisions/0022-draft-visibility-auth-shim.md.
 */
@Injectable()
export class ArticlesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actor: ActorService,
    private readonly search: SearchService,
  ) {}

  /**
   * Paginated list of non-deleted articles (ADR-0030), newest-updated first, as a `Page` envelope.
   * Each row is **lean** — the full markdown `content` is omitted ({@link ARTICLE_LIST_SELECT}); the
   * body is fetched on demand via `GET /articles/:id`. PUBLISHED is visible to all; DRAFT only to its
   * author (the current user). Optional filters: category, author, status, and a substring `q` over
   * title/excerpt. `total` counts every visible match, ignoring the page window.
   */
  async findPage(
    filters: ArticleListFilters,
    page: PageQuery,
    currentUserId?: string,
  ) {
    const cu = await this.resolveCurrentUser(currentUserId);
    const where = this.buildWhere(filters, cu);
    const { take, skip } = offsetOf(page);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.article.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        select: ARTICLE_LIST_SELECT,
        take,
        skip,
      }),
      this.prisma.article.count({ where }),
    ]);
    return pageOf(items, total, page);
  }

  /**
   * The visible-articles `where` for the list: the caller's visibility window (PUBLISHED + own
   * DRAFTs) ANDed with the optional filters. Feeds both the page query and its count (ADR-0030).
   */
  private buildWhere(
    filters: ArticleListFilters,
    currentUserId?: string,
  ): Prisma.ArticleWhereInput {
    const and: Prisma.ArticleWhereInput[] = [this.visibilityWhere(currentUserId)];
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
  async findOne(id: string, currentUserId?: string) {
    const cu = await this.resolveCurrentUser(currentUserId);
    const article = await this.prisma.article.findFirst({
      where: { id },
    });
    if (!article || (article.status === 'DRAFT' && article.authorId !== cu)) {
      throw new NotFoundException(`Article ${id} not found`);
    }
    return article;
  }

  /** Same visibility rules as findOne, looked up by slug. */
  async findBySlug(slug: string, currentUserId?: string) {
    const cu = await this.resolveCurrentUser(currentUserId);
    const article = await this.prisma.article.findFirst({
      where: { slug },
    });
    if (!article || (article.status === 'DRAFT' && article.authorId !== cu)) {
      throw new NotFoundException(`Article with slug "${slug}" not found`);
    }
    return article;
  }

  /** Create. Author = the caller (X-User-Id), never the body. Slug autogenerated when omitted. */
  async create(data: CreateArticle, currentUserId?: string) {
    const authorId = await this.requireCurrentUser(currentUserId);
    await this.assertCategoryUsable(data.categoryId);
    const slug = data.slug ?? this.deriveSlug(data.title);
    const article = await this.prisma.article.create({
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
    // Index PUBLISHED only; a DRAFT is author-private (ADR-0022) so it must never be searchable —
    // a new DRAFT is simply not indexed (nothing to do).
    if (article.status === 'PUBLISHED') {
      this.search.upsert('articles', projectArticle(article));
    }
    return article;
  }

  /** Partial update (author only). Records the editor; never changes status (use publish). */
  async update(id: string, data: UpdateArticle, currentUserId?: string) {
    const cu = await this.requireCurrentUser(currentUserId);
    await this.loadOwned(id, cu);
    if (data.categoryId) await this.assertCategoryUsable(data.categoryId);
    const { metadata, ...rest } = data;
    const article = await this.prisma.article.update({
      where: { id },
      data: {
        ...rest,
        lastEditedById: cu,
        ...(metadata !== undefined
          ? { metadata: metadata as Prisma.InputJsonValue }
          : {}),
      },
    });
    // update never changes status (publish/unpublish do), but re-sync defensively: upsert if the
    // result is PUBLISHED, else remove — keeps the index honest about draft privacy (ADR-0035).
    this.syncSearch(article);
    return article;
  }

  /** Soft delete (author only). */
  async remove(id: string, currentUserId?: string) {
    const cu = await this.requireCurrentUser(currentUserId);
    await this.loadOwned(id, cu);
    const article = await this.prisma.article.update({
      where: { id },
      data: { deletedAt: new Date(), lastEditedById: cu },
    });
    // Drop from the index so soft-deleted articles never surface in search (ADR-0035).
    this.search.remove('articles', id);
    return article;
  }

  /** Publish (author only). Sets publishedAt on the first publish; idempotent if already published. */
  async publish(id: string, currentUserId?: string) {
    const cu = await this.requireCurrentUser(currentUserId);
    const article = await this.loadOwned(id, cu);
    if (article.status === 'PUBLISHED') return article;
    const published = await this.prisma.article.update({
      where: { id },
      data: {
        status: 'PUBLISHED',
        publishedAt: article.publishedAt ?? new Date(),
        lastEditedById: cu,
      },
    });
    // Now searchable (ADR-0035).
    this.search.upsert('articles', projectArticle(published));
    return published;
  }

  /** Unpublish back to DRAFT (author only). Keeps publishedAt ("was published once"). */
  async unpublish(id: string, currentUserId?: string) {
    const cu = await this.requireCurrentUser(currentUserId);
    const article = await this.loadOwned(id, cu);
    if (article.status === 'DRAFT') return article;
    const unpublished = await this.prisma.article.update({
      where: { id },
      data: { status: 'DRAFT', lastEditedById: cu },
    });
    // Back to author-private — drop from the index (ADR-0035).
    this.search.remove('articles', id);
    return unpublished;
  }

  /** Import an article from an uploaded .md/.txt/.docx file. Author = caller. */
  async importArticle(
    file: UploadedImportFile | undefined,
    fields: ImportArticle,
    currentUserId?: string,
  ) {
    const authorId = await this.requireCurrentUser(currentUserId);
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
    const article = await this.prisma.article.create({
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
    // Same draft-privacy rule as create(): index PUBLISHED only (ADR-0022 / ADR-0035).
    if (article.status === 'PUBLISHED') {
      this.search.upsert('articles', projectArticle(article));
    }
    return article;
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
   * Resolve the X-User-Id shim: undefined → anonymous; present must be a valid live user (400).
   * Delegates to the shared {@link ActorService} (ADR-0024) — the single actor/identity resolver.
   */
  private resolveCurrentUser(
    currentUserId?: string,
  ): Promise<string | undefined> {
    return this.actor.resolve(currentUserId);
  }

  /** Like resolveCurrentUser but mandatory (writes): 400 if the header is absent. */
  private async requireCurrentUser(currentUserId?: string): Promise<string> {
    const resolved = await this.resolveCurrentUser(currentUserId);
    if (!resolved) {
      throw new BadRequestException(
        'X-User-Id header is required for this operation',
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
}
