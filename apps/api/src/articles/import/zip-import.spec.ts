import JSZip from 'jszip';
import {
  runZipImportJob,
  type ImportedArticleRow,
  type ZipImportPrismaClient,
} from './create-imported-article';
import {
  extractZipEntries,
  MAX_UNCOMPRESSED_BYTES,
  ZipQuotaExceededError,
} from './zip-extract';
import type { ImportJobData } from './import-job.types';
import type { ClaimableWikiLinkWhere } from '../wiki-link-claim';

/**
 * Unit tests for the bulk `.zip` import (ADR-0059 §5): selective extraction + the bomb-guard QUOTA
 * arm, folder mirroring, slug auto-suffix + rename reporting, skipped-entry reporting, and the
 * best-effort intra-batch `[[link]]` rewire. The HEAP-CAP arm of the bomb guard (a real expansion
 * bomb that OOMs a forked child) is exercised separately in zip-bomb.spec.ts — here we drive the
 * pure logic against an in-memory Prisma double (no Redis, no DB).
 */

const AUTHOR = '11111111-1111-1111-1111-111111111111';
const ROOT = 'root-folder';

/** Build a `.zip` buffer from a path→content map (a directory entry per folder is added by JSZip). */
async function buildZip(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

const baseZipData = (
  buffer: Buffer,
  overrides: Partial<ImportJobData> = {},
): ImportJobData => ({
  originalname: 'vault.zip',
  contentBase64: buffer.toString('base64'),
  categoryId: ROOT,
  status: 'DRAFT',
  authorId: AUTHOR,
  kind: 'zip',
  ...overrides,
});

/**
 * An in-memory Prisma double satisfying {@link ZipImportPrismaClient}. Records created articles,
 * versions, folders and wiki-link edges so the tests can assert the fan-out, the mirrored tree and
 * the rewire. `seedSlugs` pre-populates existing live article slugs (to exercise auto-suffix against
 * the DB, not just within the batch).
 */
function makePrisma(
  seedSlugs: string[] = [],
  failCreate?: (slug: string) => Error | undefined,
  opts: {
    /** Soft-deleted folder ids; the root check still sees ROOT live (it ran before the delete). */
    deletedFolders?: Set<string>;
    /** Soft-deleted article ids, for edges still cached on a deleted holder. */
    deletedArticles?: Set<string>;
    /** Edges already in the database before the job runs. */
    seedEdges?: Array<{
      sourceArticleId: string;
      targetSlug: string;
      resolvedTargetId: string | null;
    }>;
  } = {},
) {
  const deletedFolders = opts.deletedFolders ?? new Set<string>();
  const deletedArticles = opts.deletedArticles ?? new Set<string>();
  let nextArticleId = 1;
  let nextFolderId = 1;
  const articles: ImportedArticleRow[] = [];
  // Seed existing slugs as already-present articles (only their slug matters for collision checks).
  const existingBySlug = new Map<string, string>(
    seedSlugs.map((s, i) => [s, `seed-${i}`]),
  );
  interface Folder {
    id: string;
    name: string;
    parentId: string | null;
  }
  const folders = new Map<string, Folder>();
  interface Edge {
    sourceArticleId: string;
    targetSlug: string;
    resolvedTargetId: string | null;
  }
  const edges: Edge[] = [...(opts.seedEdges ?? [])];
  const isLiveFolder = (id: string) =>
    (id === ROOT || folders.has(id)) && !deletedFolders.has(id);

  const tx = {
    $queryRaw: () => Promise.resolve([]),
    $executeRaw: () => Promise.resolve(0),
    articleCategory: {
      findFirst: (args: {
        where:
          | { id: string; deletedAt: null }
          | { name: string; parentId: string; deletedAt: null };
      }) => {
        const where = args.where;
        if ('id' in where) {
          return Promise.resolve(
            isLiveFolder(where.id) ? { id: where.id } : null,
          );
        }
        for (const f of folders.values()) {
          if (
            f.name === where.name &&
            f.parentId === where.parentId &&
            !deletedFolders.has(f.id)
          ) {
            return Promise.resolve({ id: f.id });
          }
        }
        return Promise.resolve(null);
      },
      create: (args: { data: { name: string; parentId: string | null } }) => {
        const f: Folder = {
          id: `folder-${nextFolderId++}`,
          name: args.data.name,
          parentId: args.data.parentId,
        };
        folders.set(f.id, f);
        return Promise.resolve({ id: f.id });
      },
    },
    article: {
      create: (args: {
        data: {
          slug: string;
          title: string;
          content: string;
          status: string;
          categoryId: string;
        };
      }): Promise<ImportedArticleRow> => {
        const forced = failCreate?.(args.data.slug);
        if (forced) return Promise.reject(forced);
        // The live-only partial unique index on slug.
        if (existingBySlug.has(args.data.slug)) {
          return Promise.reject(
            Object.assign(new Error('Unique constraint failed'), {
              code: 'P2002',
            }),
          );
        }
        const row: ImportedArticleRow = {
          id: `art-${nextArticleId++}`,
          slug: args.data.slug,
          title: args.data.title,
          content: args.data.content,
          excerpt: null,
          status: args.data.status as ImportedArticleRow['status'],
          categoryId: args.data.categoryId,
        };
        articles.push(row);
        existingBySlug.set(row.slug, row.id);
        // Record the home folder for tree assertions.
        articleHomeFolder.set(row.id, args.data.categoryId);
        return Promise.resolve(row);
      },
      findMany: (args: {
        where: { slug: { in: string[] } };
      }): Promise<Array<{ id: string; slug: string }>> => {
        const out: Array<{ id: string; slug: string }> = [];
        for (const slug of args.where.slug.in) {
          const id = existingBySlug.get(slug);
          if (id) out.push({ id, slug });
        }
        return Promise.resolve(out);
      },
    },
    articleVersion: { create: () => Promise.resolve({}) },
    articleWikiLink: {
      createMany: (args: {
        data: Array<{
          sourceArticleId: string;
          targetSlug: string;
          resolvedTargetId: string | null;
        }>;
      }): Promise<unknown> => {
        edges.push(...args.data);
        return Promise.resolve({ count: args.data.length });
      },
    },
  };

  const articleHomeFolder = new Map<string, string>();

  const prisma: ZipImportPrismaClient = {
    $transaction: <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
    // Top-level article.findMany — the zip path pre-loads existing colliding slugs OUTSIDE any tx.
    article: { findMany: tx.article.findMany },
    articleCategory: {
      findUnique: (args: { where: { id: string } }) =>
        Promise.resolve(
          args.where.id === ROOT
            ? { id: ROOT, deletedAt: null }
            : folders.has(args.where.id)
              ? { id: args.where.id, deletedAt: null }
              : null,
        ),
    },
    articleWikiLink: {
      updateMany: (args: {
        where: ClaimableWikiLinkWhere;
        data: { resolvedTargetId: string };
      }) => {
        // Models the filter's OR: unresolved, or cached on a soft-deleted article.
        const claims = (e: Edge) =>
          args.where.OR.some((clause) =>
            'resolvedTargetId' in clause
              ? e.resolvedTargetId === null
              : e.resolvedTargetId !== null &&
                deletedArticles.has(e.resolvedTargetId),
          );
        let count = 0;
        for (const e of edges) {
          if (e.targetSlug === args.where.targetSlug && claims(e)) {
            e.resolvedTargetId = args.data.resolvedTargetId;
            count++;
          }
        }
        return Promise.resolve({ count });
      },
    },
  } as unknown as ZipImportPrismaClient;

  return {
    prisma,
    articles,
    folders,
    edges,
    articleHomeFolder,
    deletedFolders,
  };
}

describe('extractZipEntries — selective extraction + bomb-guard quota (ADR-0059 §5)', () => {
  it('extracts only .md/.txt; skips images, binaries, nested .docx, dotfiles, directories', async () => {
    const buf = await buildZip({
      'guide.md': '# Guide',
      'notes.txt': 'plain notes',
      'logo.png': 'binary-ish',
      'old.docx': 'docx-bytes',
      '.DS_Store': 'junk',
      '.obsidian/config': 'cfg',
      'sub/deep.md': '# Deep',
    });
    const { entries, skipped } = await extractZipEntries(buf);
    const textPaths = entries.map((e) => e.path).sort();
    expect(textPaths).toEqual(['guide.md', 'notes.txt', 'sub/deep.md']);
    const reasons = skipped.reduce<Record<string, number>>((acc, s) => {
      acc[s.reason] = (acc[s.reason] ?? 0) + 1;
      return acc;
    }, {});
    // png + docx are unsupported-type; .DS_Store + .obsidian/config are dotfiles.
    expect(reasons['unsupported-type']).toBe(2);
    expect(reasons['dotfile']).toBeGreaterThanOrEqual(2);
  });

  it('rejects an archive over the entry-count quota (cheap, on the central directory)', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`note-${i}.md`] = `# ${i}`;
    const buf = await buildZip(files);
    await expect(
      extractZipEntries(buf, { maxEntries: 5 }),
    ).rejects.toBeInstanceOf(ZipQuotaExceededError);
  });

  it('rejects an archive over the total-uncompressed-size quota', async () => {
    // Two ~1 MB text entries against a 1.5 MB cap → the second tips it over.
    const big = 'x'.repeat(1024 * 1024);
    const buf = await buildZip({ 'a.md': big, 'b.md': big });
    await expect(
      extractZipEntries(buf, { maxUncompressedBytes: 1.5 * 1024 * 1024 }),
    ).rejects.toBeInstanceOf(ZipQuotaExceededError);
  });

  it('skips an empty/whitespace-only text entry (no text content), never an error', async () => {
    const buf = await buildZip({ 'real.md': '# Real', 'blank.md': '   \n  ' });
    const { entries, skipped } = await extractZipEntries(buf);
    expect(entries.map((e) => e.path)).toEqual(['real.md']);
    expect(skipped.find((s) => s.path === 'blank.md')?.reason).toBe('empty');
  });

  it('throws a plain error on a non-zip / corrupt buffer (not a quota error)', async () => {
    await expect(
      extractZipEntries(Buffer.from('not a zip at all')),
    ).rejects.toThrow(/zip/i);
  });

  it('the default size cap is a generous 50 MB', () => {
    expect(MAX_UNCOMPRESSED_BYTES).toBe(50 * 1024 * 1024);
  });
});

describe('runZipImportJob — folder mirroring (ADR-0059 §5 / §1)', () => {
  it('mirrors nested zip folders into the Folder tree under the root home folder', async () => {
    const { prisma, folders, articleHomeFolder, articles } = makePrisma();
    const buf = await buildZip({
      'root.md': '# Root',
      'Servers/index.md': '# Servers',
      'Servers/Linux/provisioning.md': '# Provisioning',
      'Servers/Linux/networking.md': '# Networking',
      'Workstations/Linux/setup.md': '# WS Linux',
    });
    const { batch } = await runZipImportJob(baseZipData(buf), prisma);

    // Folders created: Servers, Servers/Linux, Workstations, Workstations/Linux = 4 (root pre-exists).
    expect(batch.foldersCreated).toBe(4);
    const byName = [...folders.values()];
    const servers = byName.find(
      (f) => f.name === 'Servers' && f.parentId === ROOT,
    );
    expect(servers).toBeDefined();
    const serversLinux = byName.find(
      (f) => f.name === 'Linux' && f.parentId === servers!.id,
    );
    expect(serversLinux).toBeDefined();
    const ws = byName.find(
      (f) => f.name === 'Workstations' && f.parentId === ROOT,
    );
    const wsLinux = byName.find(
      (f) => f.name === 'Linux' && f.parentId === ws!.id,
    );
    // Two distinct "Linux" folders, one per parent — same name coexists (partial-unique per parent).
    expect(wsLinux).toBeDefined();
    expect(serversLinux!.id).not.toBe(wsLinux!.id);

    // A root-level file homes in the root folder; a nested file homes in its leaf folder.
    const rootArticle = articles.find((a) => a.slug === 'root');
    expect(articleHomeFolder.get(rootArticle!.id)).toBe(ROOT);
    const provisioning = articles.find((a) => a.slug === 'provisioning');
    expect(articleHomeFolder.get(provisioning!.id)).toBe(serversLinux!.id);
  });

  it('fails the whole job if the root target folder is not live', async () => {
    const { prisma } = makePrisma();
    const buf = await buildZip({ 'a.md': '# A' });
    await expect(
      runZipImportJob(
        baseZipData(buf, { categoryId: 'missing-folder' }),
        prisma,
      ),
    ).rejects.toThrow(/live folder/i);
  });
});

describe('runZipImportJob — a folder deleted while the job runs (AUD-023)', () => {
  it('skips every entry and creates no folder when the root is deleted after the root check', async () => {
    const { prisma, articles, folders } = makePrisma([], undefined, {
      deletedFolders: new Set([ROOT]),
    });
    const buf = await buildZip({ 'a.md': '# A', 'Sub/b.md': '# B' });
    const { batch } = await runZipImportJob(baseZipData(buf), prisma);
    expect(articles).toHaveLength(0);
    expect(folders.size).toBe(0);
    expect(batch.foldersCreated).toBe(0);
    expect(batch.createdCount).toBe(0);
    for (const path of ['a.md', 'Sub/b.md']) {
      expect(batch.items.find((it) => it.path === path)).toMatchObject({
        outcome: 'skipped',
        reason: 'failed',
      });
    }
  });

  it('skips the later entries of a mirrored folder deleted mid-batch and keeps the rest', async () => {
    const { prisma, articles, folders, deletedFolders } = makePrisma(
      [],
      (slug) => {
        // The first article into Servers is written; the folder is deleted before the next entry.
        if (slug === 'a') {
          for (const f of folders.values()) {
            if (f.name === 'Servers') deletedFolders.add(f.id);
          }
        }
        return undefined;
      },
    );
    const buf = await buildZip({
      'Servers/a.md': '# A',
      'Servers/b.md': '# B',
      'Servers/sub/c.md': '# C',
      'z.md': '# Z',
    });
    const { batch } = await runZipImportJob(baseZipData(buf), prisma);
    expect(articles.map((a) => a.slug).sort()).toEqual(['a', 'z']);
    for (const path of ['Servers/b.md', 'Servers/sub/c.md']) {
      expect(batch.items.find((it) => it.path === path)).toMatchObject({
        outcome: 'skipped',
        reason: 'failed',
      });
    }
    // No sub-folder was created under the deleted one.
    expect([...folders.values()].some((f) => f.name === 'sub')).toBe(false);
  });
});

describe('runZipImportJob — slug auto-suffix + rename reporting (ADR-0059 §3/§5)', () => {
  it('auto-suffixes a slug that collides with an EXISTING article, and reports the rename', async () => {
    const { prisma } = makePrisma(['guide']); // "guide" already taken in the DB
    const buf = await buildZip({ 'guide.md': '# Guide' });
    const { batch } = await runZipImportJob(baseZipData(buf), prisma);
    const item = batch.items.find((it) => it.path === 'guide.md')!;
    expect(item.outcome).toBe('renamed');
    expect(item.slug).toBe('guide-2');
    expect(item.requestedSlug).toBe('guide');
    expect(batch.renamedCount).toBe(1);
    expect(batch.createdCount).toBe(0);
  });

  it('auto-suffixes WITHIN the batch (two files derive the same slug)', async () => {
    const { prisma } = makePrisma();
    const buf = await buildZip({
      'a/guide.md': '# A',
      'b/guide.md': '# B',
    });
    const { batch } = await runZipImportJob(baseZipData(buf), prisma);
    const slugs = batch.items
      .filter((it) => it.outcome !== 'skipped')
      .map((it) => it.slug)
      .sort();
    expect(slugs).toEqual(['guide', 'guide-2']);
    expect(batch.createdCount).toBe(1);
    expect(batch.renamedCount).toBe(1);
  });
});

describe('runZipImportJob — collisions and per-entry failures never abort the batch (AUD-011)', () => {
  it('skips past an EXISTING suffixed slug instead of colliding with it', async () => {
    const { prisma } = makePrisma(['setup', 'setup-2']);
    const buf = await buildZip({
      'setup.md': '# Setup',
      'other.md': '# Other',
    });
    const { batch } = await runZipImportJob(baseZipData(buf), prisma);
    const item = batch.items.find((it) => it.path === 'setup.md')!;
    expect(item.outcome).toBe('renamed');
    expect(item.slug).toBe('setup-3');
    expect(item.requestedSlug).toBe('setup');
    expect(batch.createdCount).toBe(1);
  });

  it('reports a failed entry in the batch and keeps importing the rest', async () => {
    const { prisma, articles } = makePrisma([], (slug) => {
      if (slug === 'broken') return new Error('connection reset');
      if (slug === 'pictures') {
        return new Error(
          'Attachment storage is full (the 10 MB total limit would be exceeded).',
        );
      }
      return undefined;
    });
    const buf = await buildZip({
      'a.md': '# A',
      'broken.md': '# Broken',
      'pictures.md': '# Pictures',
      'z.md': '# Z',
    });
    const { batch } = await runZipImportJob(baseZipData(buf), prisma);
    expect(articles.map((a) => a.slug).sort()).toEqual(['a', 'z']);
    const broken = batch.items.find((it) => it.path === 'broken.md')!;
    expect(broken).toMatchObject({
      outcome: 'skipped',
      articleId: null,
      slug: null,
      reason: 'failed',
    });
    const pictures = batch.items.find((it) => it.path === 'pictures.md')!;
    expect(pictures.reason).toBe('storage-full');
    expect(batch.createdCount).toBe(2);
    expect(batch.skippedCount).toBe(2);
  });

  it('reports a unique-index race on one entry instead of failing the job', async () => {
    const { prisma } = makePrisma([], (slug) =>
      slug === 'raced'
        ? Object.assign(new Error('Unique constraint failed'), {
            code: 'P2002',
          })
        : undefined,
    );
    const buf = await buildZip({ 'raced.md': '# R', 'fine.md': '# F' });
    const { batch } = await runZipImportJob(baseZipData(buf), prisma);
    expect(batch.items.find((it) => it.path === 'raced.md')?.reason).toBe(
      'failed',
    );
    expect(batch.createdCount).toBe(1);
  });
});

describe('runZipImportJob — skipped-entry reporting (ADR-0059 §5)', () => {
  it('reports every skipped entry with a reason, never as an error', async () => {
    const { prisma } = makePrisma();
    const buf = await buildZip({
      'keep.md': '# Keep',
      'photo.jpg': 'jpeg',
      '.hidden.md': '# Hidden',
    });
    const { batch } = await runZipImportJob(baseZipData(buf), prisma);
    expect(batch.createdCount).toBe(1);
    const skipped = batch.items.filter((it) => it.outcome === 'skipped');
    expect(skipped.length).toBe(batch.skippedCount);
    expect(
      skipped.some(
        (s) => s.path === 'photo.jpg' && s.reason === 'unsupported-type',
      ),
    ).toBe(true);
    expect(
      skipped.some((s) => s.path === '.hidden.md' && s.reason === 'dotfile'),
    ).toBe(true);
    // Every skipped item carries a reason and no article id.
    for (const s of skipped) {
      expect(s.reason).not.toBeNull();
      expect(s.articleId).toBeNull();
    }
  });
});

describe('runZipImportJob — best-effort [[link]] rewire (ADR-0059 §5)', () => {
  it('resolves an intra-batch forward reference after the batch is created', async () => {
    const { prisma, edges } = makePrisma();
    // first.md links to [[second]] which is created LATER in the batch (a forward reference). The
    // archive is walked in path order, so "a-first.md" (slug "a-first") is created before "second.md"
    // (slug "second") — the link is unresolved at create time and rewired by the post-batch pass.
    const buf = await buildZip({
      'a-first.md': 'See [[second]] for details',
      'second.md': '# Second',
    });
    const { batch } = await runZipImportJob(baseZipData(buf), prisma);
    // One edge from a-first → "second", initially unresolved, then rewired to z-second's id.
    const edge = edges.find((e) => e.targetSlug === 'second');
    expect(edge).toBeDefined();
    expect(edge!.resolvedTargetId).not.toBeNull();
    expect(batch.linksResolved).toBeGreaterThanOrEqual(1);
  });

  it('re-points a link still cached on a soft-deleted holder of the slug, never one on a live article', async () => {
    const { prisma, edges, articles } = makePrisma([], undefined, {
      deletedArticles: new Set(['old-guide']),
      seedEdges: [
        {
          sourceArticleId: 'src-1',
          targetSlug: 'guide',
          resolvedTargetId: 'old-guide',
        },
        {
          sourceArticleId: 'src-2',
          targetSlug: 'guide',
          resolvedTargetId: 'renamed-live',
        },
      ],
    });
    const buf = await buildZip({ 'guide.md': '# Guide' });
    const { batch } = await runZipImportJob(baseZipData(buf), prisma);
    const guide = articles.find((a) => a.slug === 'guide')!;
    expect(
      edges.find((e) => e.sourceArticleId === 'src-1')!.resolvedTargetId,
    ).toBe(guide.id);
    expect(
      edges.find((e) => e.sourceArticleId === 'src-2')!.resolvedTargetId,
    ).toBe('renamed-live');
    expect(batch.linksResolved).toBe(1);
  });

  it('leaves an unresolved link as a forward reference (tooltip), never a failure', async () => {
    const { prisma, edges } = makePrisma();
    const buf = await buildZip({ 'only.md': 'See [[nonexistent]]' });
    const { batch } = await runZipImportJob(baseZipData(buf), prisma);
    expect(batch.createdCount).toBe(1);
    const edge = edges.find((e) => e.targetSlug === 'nonexistent');
    expect(edge).toBeDefined();
    expect(edge!.resolvedTargetId).toBeNull(); // unresolved, but the import succeeded
  });
});

describe('runZipImportJob — batch result shape (ADR-0059 §5)', () => {
  it('returns a discriminated zip result with per-item outcomes and tallies', async () => {
    const { prisma } = makePrisma(['taken']);
    const buf = await buildZip({
      'fresh.md': '# Fresh',
      'taken.md': '# Taken', // collides → renamed
      'image.png': 'bin', // skipped
    });
    const result = await runZipImportJob(baseZipData(buf), prisma);
    expect(result.kind).toBe('zip');
    const { batch } = result;
    expect(batch.createdCount).toBe(1);
    expect(batch.renamedCount).toBe(1);
    expect(batch.skippedCount).toBe(1);
    expect(batch.items).toHaveLength(3);
    // Every item carries its archive path (the audit key).
    for (const it of batch.items) {
      expect(typeof it.path).toBe('string');
      expect(it.path.length).toBeGreaterThan(0);
    }
  });

  it('only indexes PUBLISHED articles from the batch (draft privacy, ADR-0022/0035)', async () => {
    const index = jest.fn();
    const { prisma } = makePrisma();
    const buf = await buildZip({ 'a.md': '# A', 'b.md': '# B' });
    await runZipImportJob(
      baseZipData(buf, { status: 'PUBLISHED' }),
      prisma,
      index,
    );
    expect(index).toHaveBeenCalledTimes(2);
  });

  it('does NOT index a DRAFT batch', async () => {
    const index = jest.fn();
    const { prisma } = makePrisma();
    const buf = await buildZip({ 'a.md': '# A' });
    await runZipImportJob(baseZipData(buf, { status: 'DRAFT' }), prisma, index);
    expect(index).not.toHaveBeenCalled();
  });
});
