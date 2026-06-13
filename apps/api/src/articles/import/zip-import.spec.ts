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
function makePrisma(seedSlugs: string[] = []) {
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
  const edges: Edge[] = [];

  const tx = {
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
            : (folders.has(args.where.id)
                ? { id: args.where.id, deletedAt: null }
                : null),
        ),
      findFirst: (args: {
        where: { name: string; parentId: string | null };
      }) => {
        for (const f of folders.values()) {
          if (f.name === args.where.name && f.parentId === args.where.parentId) {
            return Promise.resolve(f);
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
        return Promise.resolve(f);
      },
    },
    articleWikiLink: {
      updateMany: (args: {
        where: { targetSlug: string; resolvedTargetId: null };
        data: { resolvedTargetId: string };
      }) => {
        let count = 0;
        for (const e of edges) {
          if (
            e.targetSlug === args.where.targetSlug &&
            e.resolvedTargetId === null
          ) {
            e.resolvedTargetId = args.data.resolvedTargetId;
            count++;
          }
        }
        return Promise.resolve({ count });
      },
    },
  } as unknown as ZipImportPrismaClient;

  return { prisma, articles, folders, edges, articleHomeFolder };
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
    const servers = byName.find((f) => f.name === 'Servers' && f.parentId === ROOT);
    expect(servers).toBeDefined();
    const serversLinux = byName.find(
      (f) => f.name === 'Linux' && f.parentId === servers!.id,
    );
    expect(serversLinux).toBeDefined();
    const ws = byName.find((f) => f.name === 'Workstations' && f.parentId === ROOT);
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
      runZipImportJob(baseZipData(buf, { categoryId: 'missing-folder' }), prisma),
    ).rejects.toThrow(/live folder/i);
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
    expect(skipped.some((s) => s.path === 'photo.jpg' && s.reason === 'unsupported-type')).toBe(true);
    expect(skipped.some((s) => s.path === '.hidden.md' && s.reason === 'dotfile')).toBe(true);
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
