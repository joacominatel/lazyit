import {
  nextAvailableSlug,
  parseWikiLinks,
  slugify,
  type ArticleStatus,
  type ZipImportResult,
  type ZipItemResult,
} from '@lazyit/shared';
import { parseImportFile, titleFromFilename } from '../article-import';
import { extractZipEntries, type ZipExtractOptions } from './zip-extract';
import type { ArticleRow } from '../../search/search.documents';
import type {
  ImportJobData,
  ImportJobResult,
  SingleImportJobResult,
  ZipImportJobResult,
} from './import-job.types';

/**
 * The body of an article-import job (ADR-0053). Two paths share this file:
 *  - SINGLE (`.md`/`.txt`/`.docx`): parse to Markdown, create one Article + its version-1 snapshot +
 *    its `[[slug]]` wiki-link edges (ADR-0042/0059 §3), all in one transaction. The original path.
 *  - ZIP (ADR-0059 §5): selectively extract the archive (bomb-guard quota), MIRROR its nested folders
 *    into the Folder tree, create one Article per text entry (slug collisions AUTO-SUFFIXED and
 *    reported), then a best-effort intra-batch `[[link]]` rewire. The fan-out is bounded work inside
 *    the SAME sandboxed child (SEC-002) — no second queue, no second isolation primitive.
 *
 * This runs INSIDE the sandboxed worker child, which has no Nest DI container, so it takes a plain
 * Prisma-shaped client instead of the injected {@link PrismaService}. It deliberately mirrors
 * `ArticlesService` (the synchronous path it replaces): title from filename, slug derived, content
 * stored verbatim (SEC-003). The expensive/dangerous unzip happens here, where the heap-capped child
 * contains a decompression bomb (SEC-002).
 */

/** The Article columns this job writes and reads back (a structural subset of the Prisma row). */
export interface ImportedArticleRow {
  id: string;
  slug: string;
  title: string;
  content: string;
  excerpt: string | null;
  status: ArticleStatus;
  // The home folder (ADR-0060 §5): carried into the search doc as the folder-access post-filter key.
  categoryId: string;
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

/** The minimal Prisma client the SINGLE-file worker needs — satisfied structurally by PrismaClient. */
export interface ImportPrismaClient {
  $transaction<T>(fn: (tx: ImportTx) => Promise<T>): Promise<T>;
}

/** A live (non-soft-deleted) Folder row, as the zip folder-mirror pass reads/creates it. */
interface FolderRow {
  id: string;
  name: string;
  parentId: string | null;
}

/**
 * The minimal Prisma client the ZIP worker needs (ADR-0059 §5) — a superset of {@link ImportTx}
 * exposed at the TOP level (not just inside `$transaction`), because folder find-or-create and the
 * link-rewire pass span entries. Satisfied structurally by a real PrismaClient.
 */
export interface ZipImportPrismaClient extends ImportPrismaClient {
  articleCategory: {
    /** Find a live child folder by (parentId, name) — null = a root-level folder. */
    findFirst(args: {
      where: { name: string; parentId: string | null; deletedAt: null };
      select: { id: true; name: true; parentId: true };
    }): Promise<FolderRow | null>;
    /** Create a folder under `parentId` (null = root). */
    create(args: {
      data: { name: string; parentId: string | null };
      select: { id: true; name: true; parentId: true };
    }): Promise<FolderRow>;
    /** Confirm the ROOT home folder is live (the worker fails the job cleanly otherwise). */
    findUnique(args: {
      where: { id: string };
      select: { id: true; deletedAt: true };
    }): Promise<{ id: string; deletedAt: Date | null } | null>;
  };
  article: {
    findMany(args: {
      where: { slug: { in: string[] } };
      select: { id: true; slug: true };
    }): Promise<Array<{ id: string; slug: string }>>;
  };
  articleWikiLink: {
    /** Re-resolve a previously-unresolved edge to a freshly-created batch article (the §5 rewire). */
    updateMany(args: {
      where: { targetSlug: string; resolvedTargetId: null };
      data: { resolvedTargetId: string };
    }): Promise<{ count: number }>;
  };
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
 * Create one Article + its version-1 snapshot + its outgoing `[[slug]]` wiki-link edges inside ONE
 * transaction (ADR-0042/0059 §3). Shared by the single-file and zip paths. Each parsed `[[slug]]`
 * resolves best-effort to a LIVE article id (`resolvedTargetId`, else null for a forward reference —
 * never an error, never a save-blocker). Returns the created row.
 */
async function createArticleWithVersion(
  tx: ImportTx,
  params: {
    slug: string;
    title: string;
    content: string;
    status: ArticleStatus;
    categoryId: string;
    authorId: string;
  },
): Promise<ImportedArticleRow> {
  const created = await tx.article.create({
    data: {
      slug: params.slug,
      title: params.title,
      content: params.content,
      readingMinutes: readingMinutesOf(params.content),
      status: params.status,
      publishedAt: params.status === 'PUBLISHED' ? new Date() : null,
      categoryId: params.categoryId,
      authorId: params.authorId,
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
      editedById: params.authorId,
    },
  });
  // Materialize the outgoing `[[slug]]` edges (ADR-0059 §3) in the SAME transaction. A fresh import
  // has no prior edges, so this is a pure insert. Unresolved forward references stay null.
  const slugs = parseWikiLinks(created.content);
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
}

/** Best-effort PUBLISHED-only index of a created article (search is fire-and-forget, ADR-0035). */
async function indexIfPublished(
  article: ImportedArticleRow,
  index?: IndexArticle,
): Promise<void> {
  if (article.status !== 'PUBLISHED' || !index) return;
  try {
    await index({
      id: article.id,
      slug: article.slug,
      title: article.title,
      excerpt: article.excerpt,
      status: article.status,
      content: article.content,
      // Folder-access metadata for the search post-filter (ADR-0060 §5).
      categoryId: article.categoryId,
    });
  } catch {
    // swallow — search is fire-and-forget (ADR-0035)
  }
}

/**
 * Execute one SINGLE-file import job (`.md`/`.txt`/`.docx`). Throws on a parse failure / empty
 * content — the caller (the worker) lets BullMQ mark the job `failed`. A `.docx` decompression bomb
 * does not reach here gracefully: it OOMs the child during {@link parseImportFile}, which BullMQ also
 * records as a failed job.
 */
export async function runImportJob(
  data: ImportJobData,
  prisma: ImportPrismaClient,
  index?: IndexArticle,
): Promise<SingleImportJobResult> {
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

  const article = await prisma.$transaction((tx) =>
    createArticleWithVersion(tx, {
      slug,
      title,
      content,
      status: data.status,
      categoryId: data.categoryId,
      authorId: data.authorId,
    }),
  );

  await indexIfPublished(article, index);
  return { kind: 'single', articleId: article.id };
}

/**
 * Find-or-create the Folder for a path's `folderSegments`, mirroring the zip's nested tree under the
 * root home folder (ADR-0059 §1/§5). Walks segment by segment, find-or-creating each child by
 * `(parentId, name)` among LIVE rows (honouring the partial-unique), caching ids by path key so a
 * repeated folder is created once. Returns the leaf folder id (the home folder for entries directly
 * inside it). `[]` ⇒ the root folder itself.
 *
 * `cache` maps a path key (`"a/b"`) to a folder id and is mutated across calls within one job.
 * `createdCounter.count` is incremented for every folder this pass creates (for the batch audit).
 */
async function resolveFolder(
  prisma: ZipImportPrismaClient,
  rootFolderId: string,
  segments: string[],
  cache: Map<string, string>,
  createdCounter: { count: number },
): Promise<string> {
  let parentId = rootFolderId;
  let keyPrefix = '';
  for (const rawName of segments) {
    const name = rawName.trim().slice(0, 200) || rawName.slice(0, 200);
    keyPrefix = keyPrefix === '' ? name : `${keyPrefix}/${name}`;
    const cached = cache.get(keyPrefix);
    if (cached) {
      parentId = cached;
      continue;
    }
    const existing = await prisma.articleCategory.findFirst({
      where: { name, parentId, deletedAt: null },
      select: { id: true, name: true, parentId: true },
    });
    let folderId: string;
    if (existing) {
      folderId = existing.id;
    } else {
      const created = await prisma.articleCategory.create({
        data: { name, parentId },
        select: { id: true, name: true, parentId: true },
      });
      folderId = created.id;
      createdCounter.count += 1;
    }
    cache.set(keyPrefix, folderId);
    parentId = folderId;
  }
  return parentId;
}

/**
 * Execute one ZIP bulk-import job (ADR-0059 §5), INSIDE the sandboxed child:
 *  1. Selectively extract the archive (bomb-guard quota on entry count + uncompressed size). A bomb
 *     that slips the metadata quota still OOMs the heap-capped child (SEC-002).
 *  2. Confirm the ROOT home folder (`data.categoryId`) is live — fail the job cleanly if not.
 *  3. For each text entry: mirror its folders, derive + AUTO-SUFFIX its slug (collisions reported,
 *     never a 409), and create the Article + version + wiki-link edges in one transaction.
 *  4. Best-effort intra-batch `[[link]]` rewire: re-resolve still-unresolved edges to the freshly
 *     created batch slugs. Unresolved degrades to the §3 tooltip — never a failure.
 * Returns the per-item batch result. Throws only on a hard failure (corrupt zip, over-quota, or a
 * missing root folder); a per-entry hiccup is reported, never fatal.
 */
export async function runZipImportJob(
  data: ImportJobData,
  prisma: ZipImportPrismaClient,
  index?: IndexArticle,
  extractOpts?: ZipExtractOptions,
): Promise<ZipImportJobResult> {
  const buffer = Buffer.from(data.contentBase64, 'base64');
  // DANGEROUS step: the archive is unzipped here. The quota rejects an over-large/over-many archive;
  // a high-ratio bomb that lies about its sizes still OOMs the heap-capped child (SEC-002).
  const { entries, skipped } = await extractZipEntries(buffer, extractOpts);

  // The root home folder under which the mirrored tree is grafted must be live (the worker would
  // otherwise fail every per-entry create on the FK). Fail the whole job cleanly.
  const root = await prisma.articleCategory.findUnique({
    where: { id: data.categoryId },
    select: { id: true, deletedAt: true },
  });
  if (!root || root.deletedAt) {
    throw new Error('The import target folder does not reference a live folder');
  }

  const items: ZipItemResult[] = [];
  // Every skipped entry is reported (never an error) so nothing is swallowed (§5).
  for (const s of skipped) {
    items.push({
      path: s.path,
      outcome: 'skipped',
      articleId: null,
      slug: null,
      requestedSlug: null,
      reason: s.reason,
    });
  }

  // Seed the slug-collision predicate with the live slugs that collide with any derived base, so the
  // first auto-suffix is correct against EXISTING articles too (not just within the batch). One query.
  const requestedSlugs = entries.map((e) =>
    slugify(titleFromFilename(e.fileName)),
  );
  const existing = await prisma.article.findMany({
    where: { slug: { in: requestedSlugs.filter((s) => s !== '') } },
    select: { id: true, slug: true },
  });
  const takenSlugs = new Set(existing.map((e) => e.slug));
  const folderCache = new Map<string, string>();
  const foldersCreated = { count: 0 };
  // slug → created article id, for the post-batch link rewire (only batch-minted articles).
  const batchSlugToId = new Map<string, string>();
  const created: ImportedArticleRow[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const title = titleFromFilename(entry.fileName);
    const base = requestedSlugs[i];
    if (base === '') {
      // A filename with no usable slug characters (e.g. "___.md") — skip, never an error.
      items.push({
        path: entry.path,
        outcome: 'skipped',
        articleId: null,
        slug: null,
        requestedSlug: null,
        reason: 'empty',
      });
      continue;
    }
    // AUTO-SUFFIX on collision (§3). nextAvailableSlug is PURE; record the minted slug before the
    // next call so a within-batch duplicate gets its own suffix.
    const finalSlug = nextAvailableSlug(base, (c) => takenSlugs.has(c));
    takenSlugs.add(finalSlug);

    const homeFolderId = await resolveFolder(
      prisma,
      data.categoryId,
      entry.folderSegments,
      folderCache,
      foldersCreated,
    );

    const article = await prisma.$transaction((tx) =>
      createArticleWithVersion(tx, {
        slug: finalSlug,
        title,
        content: entry.content,
        status: data.status,
        categoryId: homeFolderId,
        authorId: data.authorId,
      }),
    );
    created.push(article);
    batchSlugToId.set(finalSlug, article.id);

    items.push({
      path: entry.path,
      outcome: finalSlug === base ? 'created' : 'renamed',
      articleId: article.id,
      slug: finalSlug,
      requestedSlug: finalSlug === base ? null : base,
      reason: null,
    });
  }

  // Best-effort intra-batch `[[link]]` rewire (§5): an edge created earlier in the batch may point at
  // a slug only minted LATER in the same batch (a forward reference). Re-resolve every batch slug's
  // still-unresolved inbound edges to its new article id. Unresolved (a slug nobody minted) degrades
  // to the §3 tooltip — never a failure. Each update is independent; a hiccup is swallowed.
  let linksResolved = 0;
  for (const [slug, id] of batchSlugToId) {
    try {
      const res = await prisma.articleWikiLink.updateMany({
        where: { targetSlug: slug, resolvedTargetId: null },
        data: { resolvedTargetId: id },
      });
      linksResolved += res.count;
    } catch {
      // swallow — link resolution is best-effort (§5), never a failure of the import.
    }
  }

  // Index PUBLISHED articles (best-effort, after the batch is durable).
  for (const article of created) {
    await indexIfPublished(article, index);
  }

  const createdCount = items.filter((it) => it.outcome === 'created').length;
  const renamedCount = items.filter((it) => it.outcome === 'renamed').length;
  const skippedCount = items.filter((it) => it.outcome === 'skipped').length;
  const batch: ZipImportResult = {
    foldersCreated: foldersCreated.count,
    items,
    createdCount,
    renamedCount,
    skippedCount,
    linksResolved,
  };
  return { kind: 'zip', batch };
}

/** Dispatch an import job to the single-file or zip path by its `kind` (absent ⇒ single). */
export async function runAnyImportJob(
  data: ImportJobData,
  prisma: ZipImportPrismaClient,
  index?: IndexArticle,
): Promise<ImportJobResult> {
  if (data.kind === 'zip') {
    return runZipImportJob(data, prisma, index);
  }
  return runImportJob(data, prisma, index);
}
