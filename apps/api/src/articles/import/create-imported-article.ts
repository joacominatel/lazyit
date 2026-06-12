import {
  parseWikiLinks,
  slugify,
  type ArticleStatus,
} from '@lazyit/shared';
import { parseImportFile, titleFromFilename } from '../article-import';
import type { ArticleRow } from '../../search/search.documents';
import type { ImportJobData, ImportJobResult } from './import-job.types';

/**
 * The body of an article-import job (ADR-0053): parse the uploaded file to Markdown, then create the
 * Article + its version-1 snapshot (ADR-0042). This runs INSIDE the sandboxed worker child, which
 * has no Nest DI container, so it takes a plain Prisma-shaped client instead of the injected
 * {@link PrismaService}. It deliberately mirrors `ArticlesService.importArticle` (the synchronous
 * path it replaces): title from filename, slug derived, content stored verbatim (SEC-003), version 1
 * appended in the same transaction. The expensive/dangerous `.docx` parse happens here, where the
 * heap-capped child contains a decompression bomb (SEC-002).
 */

/** The Article columns this job writes and reads back (a structural subset of the Prisma row). */
export interface ImportedArticleRow {
  id: string;
  slug: string;
  title: string;
  content: string;
  excerpt: string | null;
  status: ArticleStatus;
}

interface ArticleCreateArgs {
  data: {
    slug: string;
    title: string;
    content: string;
    readingMinutes: number;
    status: ArticleStatus;
    publishedAt: Date | null;
    categoryId: string;
    authorId: string;
  };
}

interface ArticleVersionCreateArgs {
  data: {
    articleId: string;
    version: number;
    title: string;
    content: string;
    excerpt: string | null;
    status: ArticleStatus;
    editedById: string | null;
  };
}

interface ArticleWikiLinkCreateManyArgs {
  data: Array<{
    sourceArticleId: string;
    targetSlug: string;
    resolvedTargetId: string | null;
  }>;
}

/** The transaction-scoped slice of Prisma the create path uses. */
export interface ImportTx {
  article: {
    create(args: ArticleCreateArgs): Promise<ImportedArticleRow>;
    findMany(args: {
      where: { slug: { in: string[] } };
      select: { id: true; slug: true };
    }): Promise<Array<{ id: string; slug: string }>>;
  };
  articleVersion: { create(args: ArticleVersionCreateArgs): Promise<unknown> };
  articleWikiLink: {
    createMany(args: ArticleWikiLinkCreateManyArgs): Promise<unknown>;
  };
}

/** The minimal Prisma client the worker needs — satisfied structurally by a real PrismaClient. */
export interface ImportPrismaClient {
  $transaction<T>(fn: (tx: ImportTx) => Promise<T>): Promise<T>;
}

/**
 * Optional post-create indexing hook. Search sync is fire-and-forget (ADR-0035) and lives in the
 * main process via {@link SearchService}; the lean child takes a callback so it never pulls in the
 * Meili (ESM) client. Only PUBLISHED articles are ever indexed (draft privacy, ADR-0022/0035).
 */
export type IndexArticle = (doc: ArticleRow) => void | Promise<void>;

/**
 * Estimated reading time of a Markdown body in whole minutes. Mirrors
 * `ArticlesService.readingMinutesOf` (and the SQL backfill) so the `readingMinutes` column stays
 * consistent across the create/update/import paths (ADR-0042).
 */
function readingMinutesOf(content: string): number {
  const trimmed = content.trim();
  if (trimmed === '') return 0;
  const words = trimmed.split(/\s+/).length;
  return Math.max(1, Math.ceil(words / 200));
}

/** Derive a slug from the title; throw if nothing usable remains (mirrors the service). */
function deriveSlug(title: string): string {
  const slug = slugify(title);
  if (!slug) {
    throw new Error(
      'Could not derive a slug from the title; provide an explicit slug',
    );
  }
  return slug;
}

/**
 * Execute one import job. Throws on a parse failure / empty content — the caller (the worker)
 * lets BullMQ mark the job `failed`. A `.docx` decompression bomb does not reach here gracefully:
 * it OOMs the child during {@link parseImportFile}, which BullMQ also records as a failed job.
 */
export async function runImportJob(
  data: ImportJobData,
  prisma: ImportPrismaClient,
  index?: IndexArticle,
): Promise<ImportJobResult> {
  const buffer = Buffer.from(data.contentBase64, 'base64');
  // DANGEROUS step: .docx is unzipped/parsed here. In the sandboxed child a bomb dies under the
  // heap cap (SEC-002); md/txt are read verbatim.
  const content = await parseImportFile({
    originalname: data.originalname,
    buffer,
  });
  if (!content.trim()) {
    throw new Error('The imported file has no text content');
  }

  const title = data.title ?? titleFromFilename(data.originalname);
  const slug = data.slug ?? deriveSlug(title);
  const status = data.status;

  const article = await prisma.$transaction(async (tx) => {
    const created = await tx.article.create({
      data: {
        slug,
        title,
        content,
        readingMinutes: readingMinutesOf(content),
        status,
        publishedAt: status === 'PUBLISHED' ? new Date() : null,
        categoryId: data.categoryId,
        authorId: data.authorId,
      },
    });
    // An import is a create — version 1 (ADR-0042); same transaction so both commit atomically.
    await tx.articleVersion.create({
      data: {
        articleId: created.id,
        version: 1,
        title: created.title,
        content: created.content,
        excerpt: created.excerpt,
        status: created.status,
        editedById: data.authorId,
      },
    });
    // Materialize the outgoing `[[slug]]` wiki-link edges (ADR-0059 §3), in the SAME transaction as
    // the article + version write. A fresh import has no prior edges, so this is a pure insert (the
    // service's rebuild deletes-then-inserts; here delete is a no-op). Each slug resolves best-effort
    // to a LIVE article — an unresolved forward reference stays null (never blocks the import).
    const slugs = parseWikiLinks(content);
    if (slugs.length > 0) {
      const matches = await tx.article.findMany({
        where: { slug: { in: slugs } },
        select: { id: true, slug: true },
      });
      const idBySlug = new Map(matches.map((m) => [m.slug, m.id]));
      await tx.articleWikiLink.createMany({
        data: slugs.map((targetSlug) => ({
          sourceArticleId: created.id,
          targetSlug,
          resolvedTargetId: idBySlug.get(targetSlug) ?? null,
        })),
      });
    }
    return created;
  });

  // Index PUBLISHED only (a DRAFT is author-private — ADR-0022/0035). Best-effort: never fail the
  // import because search sync hiccuped.
  if (article.status === 'PUBLISHED' && index) {
    try {
      await index({
        id: article.id,
        slug: article.slug,
        title: article.title,
        excerpt: article.excerpt,
        status: article.status,
        content: article.content,
      });
    } catch {
      // swallow — search is fire-and-forget (ADR-0035)
    }
  }

  return { articleId: article.id };
}
