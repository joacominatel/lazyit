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
  type ArticleLinkedFilter,
  type ArticleLinkedTo,
  type ArticleListItem,
  type ArticleStatus,
  type CreateArticle,
  type CreateArticleLink,
  type Page,
  type PageQuery,
  type UpdateArticle,
} from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import type { Article, User } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
import { isServicePrincipal, type Principal } from '../auth/principal';
import { SearchService } from '../search/search.service';
import { projectArticle, type ArticleRow } from '../search/search.documents';

/**
 * Listing filters for GET /articles. The `categoryId`, `status` and `linkedTo` filters are
 * **multi-select** (#198): each carries one or more values that **OR-combine within the filter**
 * (a `{ in: [...] }` / OR predicate) and **AND-combine across filters**. The controller parses the
 * comma-encoded/repeated query params to arrays (validating + de-duplicating each element) before
 * they reach the service; an empty array is never passed (the controller omits the filter instead).
 */
export interface ArticleListFilters {
  /** One or more categories; an article matches if its `categoryId` is in the set (#198). */
  categoryId?: string[];
  authorId?: string;
  /** One or more statuses; an article matches if its `status` is in the set (#198). */
  status?: ArticleStatus[];
  q?: string;
  /** `only` → restrict to articles that have ≥1 ArticleLink (ADR-0042). Omitted = no link filter. */
  linked?: ArticleLinkedFilter;
  /**
   * Narrows `linked` to one or more target kinds (ADR-0042 / #198): `asset` keeps articles linked to
   * ≥1 Asset, `application` those linked to ≥1 Application; passing both unions them (linked to an
   * Asset OR an Application). Implies the linked filter even if `linked` is omitted.
   */
  linkedTo?: ArticleLinkedTo[];
  /**
   * Narrows the linked filter to **specific** Assets (issue #213): keep only articles linked to ≥1 of
   * these exact Assets (`links: { some: { assetId: { in } } }`). More granular than `linkedTo=asset`
   * (any Asset) — selecting any id implies `linked=only`. OR-combines within the kind (any of these
   * assets) and across kinds with {@link applicationId} (linked to one of these assets OR these apps).
   */
  assetId?: string[];
  /**
   * Narrows the linked filter to **specific** Applications (issue #213): keep only articles linked to
   * ≥1 of these exact Applications (`links: { some: { applicationId: { in } } }`). The Application
   * counterpart of {@link assetId}; selecting any id implies `linked=only`.
   */
  applicationId?: string[];
}

/**
 * Filters for the **reverse** KB lookups (`GET /assets/:id/articles`, `GET /applications/:id/articles`
 * — #220). Mirrors the `GET /articles` multi-select convention (#198): `categoryId`/`status` are
 * `{ in: [...] }` (OR within a filter), `q` is a case-insensitive substring over title/excerpt. The
 * controllers parse the comma-encoded/repeated query params to arrays (validating + de-duplicating
 * each element; an empty array is never passed) before they reach the service. Note: the reverse list
 * is **always** PUBLISHED-only (drafts are author-private and never surface here), so a `status`
 * filter only ever narrows *within* PUBLISHED — `status=DRAFT` validly parses but matches nothing (no
 * draft leak). The base scope (the asset/application this list is for) is supplied separately.
 */
export interface ReverseArticleListFilters {
  /** One or more categories; an article matches if its `categoryId` is in the set (#198). */
  categoryId?: string[];
  /** One or more statuses (#198). ANDed on top of the hard PUBLISHED pin — never widens it. */
  status?: ArticleStatus[];
  /** Case-insensitive substring over title/excerpt. */
  q?: string;
}

// Lean projection for the LIST (GET /articles, paginated): every Article column EXCEPT `content` —
// the full Markdown body, the largest column, which a list view never renders (`excerpt` is kept).
// Adds the maintained `readingMinutes` metric and a relation `_count` of `links` — both produced by
// the query, so the card UI gets a reading time + "linked" indicator with NO body load and NO N+1.
// The detail reads (findOne / findBySlug) still return the full Article incl. `content`. See
// packages/shared/src/schemas/article-list.ts and ADR-0030 / ADR-0042 / the perf analysis (#3).
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
  readingMinutes: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  // Per-row link tally in ONE query (no N+1) — mapped to the flat `linkCount` before returning.
  _count: { select: { links: true } },
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
   * status, a substring `q` over title/excerpt, and a `linked`/`linkedTo` filter (ADR-0042) that
   * keeps only articles with ≥1 ArticleLink (optionally narrowed to an asset/application target).
   * Each row carries the precomputed `readingMinutes` and a `linkCount` (relation `_count`, flattened
   * here) so the card UI gets a reading metric + "linked" indicator with no body load and no N+1.
   */
  async findPage(
    filters: ArticleListFilters,
    page: PageQuery,
    currentUser?: User,
  ) {
    const where = this.buildWhere(filters, currentUser);
    const { take, skip } = offsetOf(page);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.article.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take,
        skip,
        select: ARTICLE_LIST_SELECT,
      }),
      this.prisma.article.count({ where }),
    ]);
    // Flatten Prisma's nested `_count.links` into the flat `linkCount` the DTO exposes. The lean rows
    // carry `Date`s; the API serializes them to ISO strings at the HTTP boundary (same as findOne) —
    // the ArticleListPage DTO documents the resulting wire shape (content omitted, linkCount added).
    const items = rows.map(({ _count, ...row }) => ({
      ...row,
      linkCount: _count.links,
    }));
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
    // Multi-select (#198): categoryId / status are `{ in: [...] }` (OR within the filter). The
    // controller never passes an empty array — an empty selection omits the filter entirely.
    if (filters.categoryId?.length) {
      and.push({ categoryId: { in: filters.categoryId } });
    }
    if (filters.authorId) and.push({ authorId: filters.authorId });
    if (filters.status?.length) {
      and.push({ status: { in: filters.status } });
    }
    if (filters.q) {
      and.push({
        OR: [
          { title: { contains: filters.q, mode: 'insensitive' } },
          { excerpt: { contains: filters.q, mode: 'insensitive' } },
        ],
      });
    }
    const linkedWhere = this.linkedWhere(filters);
    if (linkedWhere) and.push(linkedWhere);
    return { AND: and };
  }

  /**
   * The `linked`/`linkedTo`/`assetId`/`applicationId` clause for the article list (ADR-0042 / #198 /
   * #213). `linked=only` (or any narrowing param) keeps only articles with ≥1 ArticleLink via a
   * relation `some` EXISTS subquery; the narrowing composes from two layers, both implying the link
   * filter even when `linked` is omitted:
   *
   *  - **kind-level (#198):** `linkedTo` keeps any link to that target *column*
   *    (`asset` → `assetId: { not: null }`).
   *  - **entity-level (#213):** `assetId[]` / `applicationId[]` keep only links to *those exact*
   *    rows (`assetId: { in: [...] }`). More granular than a kind, so a specific selection **wins
   *    within its kind** — picking specific assets narrows the asset side to `{ in }`, ignoring a
   *    redundant `linkedTo=asset` (any asset).
   *
   * Per-kind the predicate is built independently (entity-level if present, else kind-level); the two
   * kinds **OR-combine**. With a single active kind that's one `links: { some: <pred> }`. With BOTH
   * kinds active it's `OR: [{ links: { some: assetPred } }, { links: { some: appPred } }]` — an
   * ArticleLink is asset XOR application (a row is never both), so a single `some` carrying both
   * columns could never match; the OR-across-two-`some` shape is what "linked to one of these assets
   * OR one of these apps" means. The legacy kind-only "both kinds" case (`linkedTo=asset,application`
   * with no specific ids) stays the collapsed unnarrowed `some: {}` ("has ≥1 link", one subquery),
   * preserving #198's behavior.
   *
   * Returns `undefined` when no link filter was asked for (the list then includes both linked and
   * unlinked articles). Every branch is an EXISTS subquery — it doesn't multiply rows, so it composes
   * cleanly with the page + count.
   */
  private linkedWhere(
    filters: ArticleListFilters,
  ): Prisma.ArticleWhereInput | undefined {
    const kinds = filters.linkedTo ?? [];
    const assetIds = filters.assetId ?? [];
    const applicationIds = filters.applicationId ?? [];
    const hasNarrowing =
      kinds.length > 0 || assetIds.length > 0 || applicationIds.length > 0;
    if (!filters.linked && !hasNarrowing) return undefined;

    // Per-kind predicate: a specific-entity `{ in }` (#213) is more granular than a kind's
    // `{ not: null }` (#198), so it wins when both are present for that kind.
    const wantsAsset = assetIds.length > 0 || kinds.includes('asset');
    const wantsApplication =
      applicationIds.length > 0 || kinds.includes('application');
    const assetPred: Prisma.ArticleLinkWhereInput | undefined = wantsAsset
      ? assetIds.length > 0
        ? { assetId: { in: assetIds } }
        : { assetId: { not: null } }
      : undefined;
    const applicationPred: Prisma.ArticleLinkWhereInput | undefined =
      wantsApplication
        ? applicationIds.length > 0
          ? { applicationId: { in: applicationIds } }
          : { applicationId: { not: null } }
        : undefined;

    // No kind/entity narrowing at all (bare linked=only) → any link counts.
    if (!assetPred && !applicationPred) {
      return { links: { some: {} } };
    }
    // Legacy #198 fast path: BOTH kinds via `linkedTo` only (no specific ids) collapses to the
    // unnarrowed `some: {}` — "linked to an Asset OR an Application" is exactly "has ≥1 link".
    if (
      assetIds.length === 0 &&
      applicationIds.length === 0 &&
      assetPred &&
      applicationPred
    ) {
      return { links: { some: {} } };
    }
    // Exactly one active kind → a single `some`.
    if (assetPred && !applicationPred) {
      return { links: { some: assetPred } };
    }
    if (applicationPred && !assetPred) {
      return { links: { some: applicationPred } };
    }
    // Both kinds active with at least one specific-entity narrowing → OR across two `some` EXISTS
    // (a link row is asset XOR application, so the two columns can't co-match in one `some`).
    return {
      OR: [
        { links: { some: assetPred! } },
        { links: { some: applicationPred! } },
      ],
    };
  }

  /**
   * Estimated reading time of a markdown body in whole minutes — the value maintained in
   * `Article.readingMinutes` (ADR-0042). ~200 words/minute; min 1 for any non-empty body, 0 for an
   * empty/whitespace-only one. A "word" is a whitespace-separated token, matching the SQL backfill in
   * the migration (`regexp_split_to_array(trim(content), '\s+')`) so the column and this helper agree.
   */
  private readingMinutesOf(content: string): number {
    const trimmed = content.trim();
    if (trimmed === '') return 0;
    const words = trimmed.split(/\s+/).length;
    return Math.max(1, Math.ceil(words / 200));
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
  async create(data: CreateArticle, principal?: Principal) {
    const authorId = this.requireAuthor(principal);
    await this.assertCategoryUsable(data.categoryId);
    const slug = data.slug ?? this.deriveSlug(data.title);
    const article = await this.prisma.$transaction(async (tx) => {
      const created = await tx.article.create({
        data: {
          slug,
          title: data.title,
          content: data.content,
          readingMinutes: this.readingMinutesOf(data.content),
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
  async update(id: string, data: UpdateArticle, principal?: Principal) {
    const cu = this.requireAuthor(principal);
    const current = await this.loadOwned(id, cu);
    if (data.categoryId) await this.assertCategoryUsable(data.categoryId);
    const { metadata, ...rest } = data;
    const article = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.article.update({
        where: { id },
        data: {
          ...rest,
          lastEditedById: cu,
          // Keep the maintained reading metric in sync whenever the body changes (ADR-0042); a
          // metadata/title-only PATCH leaves `content` absent, so readingMinutes is untouched.
          ...(data.content !== undefined
            ? { readingMinutes: this.readingMinutesOf(data.content) }
            : {}),
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
  async remove(id: string, principal?: Principal) {
    const cu = this.requireAuthor(principal);
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
  async restore(id: string, principal?: Principal) {
    const cu = this.requireAuthor(principal);
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
  async publish(id: string, principal?: Principal) {
    const cu = this.requireAuthor(principal);
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
  async unpublish(id: string, principal?: Principal) {
    const cu = this.requireAuthor(principal);
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

  // Article import is now ASYNC (ADR-0053): the synchronous parse-and-create that used to live here
  // moved to the sandboxed worker (articles/import/) so a hostile .docx is parsed in a heap-capped
  // child, not the API (SEC-002). The controller enqueues via ArticleImportService; the worker's
  // create path mirrors create() above (article + version-1 snapshot).

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
    principal?: Principal,
  ) {
    const cu = this.requireAuthor(principal);
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
  async removeLink(articleId: string, linkId: string, principal?: Principal) {
    const cu = this.requireAuthor(principal);
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
   * Reverse lookup: a **page** of the PUBLISHED articles linked to a given asset
   * (`GET /assets/:id/articles`). DRAFTs are excluded (a draft is author-private; this list is
   * asset-scoped, not author-scoped, so it only ever exposes team-visible articles). Paginated +
   * filterable (#220): `take`/`skip` and a paired `count` over the **same** `where`, newest-updated
   * first; optional `q`/`status`/`categoryId` filters (#198 multi-select). Returns the lean
   * `ArticleListItem` page envelope (no content; `linkCount`/`readingMinutes` added). See ADR-0030 /
   * ADR-0042.
   */
  async findArticlesForAsset(
    assetId: string,
    filters: ReverseArticleListFilters = {},
    page: PageQuery,
  ): Promise<Page<ArticleListItem>> {
    return this.findLinkedArticlesPage(
      { links: { some: { assetId } } },
      filters,
      page,
    );
  }

  /**
   * Reverse lookup: a **page** of the PUBLISHED articles linked to a given application
   * (`GET /applications/:id/articles` — "the runbook for THIS app"). Mirrors
   * {@link findArticlesForAsset}: DRAFTs are excluded (a draft is author-private; this list is
   * application-scoped, not author-scoped), paginated + filterable (#220), and returns the lean
   * `ArticleListItem` page envelope (no content).
   */
  async findArticlesForApplication(
    applicationId: string,
    filters: ReverseArticleListFilters = {},
    page: PageQuery,
  ): Promise<Page<ArticleListItem>> {
    return this.findLinkedArticlesPage(
      { links: { some: { applicationId } } },
      filters,
      page,
    );
  }

  /**
   * Shared engine for the reverse KB lookups (#220). Runs the page `findMany(take/skip)` and the
   * `count` over the **same** `where` inside one `$transaction` (so `total` can't drift from the page)
   * and flattens the lean rows into the `ArticleListItem` shape (`_count.links` → `linkCount`). The
   * `where` always pins `status: 'PUBLISHED'` (drafts never leak — the scope is the linked record, not
   * the author), ANDs the caller-supplied scope (`links: { some: { assetId|applicationId } }`) and the
   * optional `q`/`status`/`categoryId` filters (#198). The page+count share one `where`, so a `status`
   * filter narrowing *within* PUBLISHED is reflected identically in both.
   */
  private async findLinkedArticlesPage(
    scope: Prisma.ArticleWhereInput,
    filters: ReverseArticleListFilters,
    page: PageQuery,
  ): Promise<Page<ArticleListItem>> {
    const where = this.buildReverseWhere(scope, filters);
    const { take, skip } = offsetOf(page);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.article.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take,
        skip,
        select: ARTICLE_LIST_SELECT,
      }),
      this.prisma.article.count({ where }),
    ]);
    // Same flatten as findPage: Prisma's nested `_count.links` → the flat `linkCount` the DTO exposes.
    const items = rows.map(({ _count, ...row }) => ({
      ...row,
      linkCount: _count.links,
    })) as unknown as ArticleListItem[];
    return pageOf(items, total, page);
  }

  /**
   * The shared `where` for a reverse KB lookup (#220) — used identically by its page + count. Pins the
   * hard PUBLISHED rule and the link scope, then ANDs the optional multi-select filters (#198): a
   * `categoryId`/`status` `{ in: [...] }` (OR within the filter) and a `q` substring over title/excerpt.
   * The controller never passes an empty filter array (an empty selection omits the filter entirely).
   */
  private buildReverseWhere(
    scope: Prisma.ArticleWhereInput,
    filters: ReverseArticleListFilters,
  ): Prisma.ArticleWhereInput {
    const and: Prisma.ArticleWhereInput[] = [{ status: 'PUBLISHED' }, scope];
    if (filters.categoryId?.length) {
      and.push({ categoryId: { in: filters.categoryId } });
    }
    if (filters.status?.length) {
      and.push({ status: { in: filters.status } });
    }
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
   * Resolve the author/editor of an article WRITE from the unified principal (ADR-0042 + ADR-0048).
   *
   * Articles are authored and OWNED by a human: `Article.authorId` is a NON-NULL `User` FK (onDelete
   * Restrict) and the author-only edit gate is identity equality on `User.id`. A service account has no
   * `User` identity to own an article — so SA article-authoring is **out of scope by data model**, not
   * a silent null write: a service-account principal is rejected with **403** (honest: a bot cannot be
   * the author), exactly where a human would be required. The ArticleVersion/ArticleLink SA actor
   * columns therefore stay schema-present but unreachable — no audit row is ever produced for an SA here.
   *
   * - human  → returns `User.id` (used as `authorId` / the ownership key, behavior-preserving).
   * - service account → 403 ForbiddenException.
   * - anonymous (shim, no resolved user) → 400 BadRequestException (unchanged for humans).
   */
  private requireAuthor(principal?: Principal): string {
    if (isServicePrincipal(principal)) {
      throw new ForbiddenException(
        'Service accounts cannot author or edit articles (an article author is a human user)',
      );
    }
    const resolved = principal?.user.id;
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
