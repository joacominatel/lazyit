import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  runImportJob,
  type ImportedArticleRow,
  type ImportPrismaClient,
  type ImportTx,
} from './create-imported-article';
import type { ImportJobData } from './import-job.types';
import {
  IMPORT_FOLDER_GONE_MESSAGE,
  IMPORT_SLUG_TAKEN_MESSAGE,
} from './import-job.constants';
import { claimableWikiLinksWhere } from '../wiki-link-claim';

const AUTHOR = '11111111-1111-1111-1111-111111111111';

const fixture = (name: string): Buffer =>
  readFileSync(join(__dirname, '../../../test/fixtures', name));

const b64 = (s: string): string => Buffer.from(s).toString('base64');

const baseData = (overrides: Partial<ImportJobData> = {}): ImportJobData => ({
  originalname: 'a.md',
  contentBase64: b64('# Hello\n\nWorld'),
  categoryId: 'c1',
  status: 'DRAFT',
  authorId: AUTHOR,
  ...overrides,
});

/**
 * A Prisma double that records the writes and echoes a created row back from the create args.
 * `liveSlugs` are held by existing live articles; a create on one of them fails like the unique index.
 * `deletedSlugs` are held only by soft-deleted articles; `deletedFolders` are soft-deleted folders.
 */
function makePrisma(
  liveSlugs: string[] = [],
  opts: { deletedSlugs?: string[]; deletedFolders?: string[] } = {},
) {
  const deletedSlugs = opts.deletedSlugs ?? [];
  const deletedFolders = opts.deletedFolders ?? [];
  const articleCreate = jest.fn(
    (args: {
      data: {
        slug: string;
        title: string;
        content: string;
        status: string;
        categoryId: string;
        authorId: string;
        publishedAt: Date | null;
      };
    }): Promise<ImportedArticleRow> =>
      liveSlugs.includes(args.data.slug)
        ? Promise.reject(
            Object.assign(new Error('Unique constraint failed'), {
              code: 'P2002',
            }),
          )
        : Promise.resolve({
            id: 'art1',
            slug: args.data.slug,
            title: args.data.title,
            content: args.data.content,
            excerpt: null,
            status: args.data.status as ImportedArticleRow['status'],
            categoryId: args.data.categoryId,
          }),
  );
  // The worker's client has no soft-delete extension: a deleted holder matches unless the query filters it.
  const articleFindMany = jest.fn(
    (args: { where: { slug: { in: string[] }; deletedAt?: null } }) =>
      Promise.resolve([
        ...args.where.slug.in
          .filter((slug) => liveSlugs.includes(slug))
          .map((slug) => ({ id: `live-${slug}`, slug })),
        ...(args.where.deletedAt === null
          ? []
          : args.where.slug.in
              .filter((slug) => deletedSlugs.includes(slug))
              .map((slug) => ({ id: `deleted-${slug}`, slug }))),
      ]),
  );
  const queryRaw = jest.fn(() => Promise.resolve([]));
  const folderFindFirst = jest.fn(
    (args: { where: { id: string; deletedAt?: null } }) =>
      Promise.resolve(
        args.where.deletedAt === null && deletedFolders.includes(args.where.id)
          ? null
          : { id: args.where.id },
      ),
  );
  const wikiLinkCreateMany = jest.fn(() => Promise.resolve({ count: 0 }));
  const wikiLinkUpdateMany = jest.fn(() => Promise.resolve({ count: 0 }));
  const versionCreate = jest.fn((args: { data: Record<string, unknown> }) =>
    Promise.resolve(args),
  );
  const tx = {
    $queryRaw: queryRaw,
    articleCategory: { findFirst: folderFindFirst },
    article: { create: articleCreate, findMany: articleFindMany },
    articleVersion: { create: versionCreate },
    articleWikiLink: {
      createMany: wikiLinkCreateMany,
      updateMany: wikiLinkUpdateMany,
    },
  } as unknown as ImportTx;
  const prisma: ImportPrismaClient = {
    $transaction: <T>(fn: (t: ImportTx) => Promise<T>) => fn(tx),
  };
  return {
    prisma,
    articleCreate,
    versionCreate,
    wikiLinkUpdateMany,
    wikiLinkCreateMany,
    queryRaw,
  };
}

describe('runImportJob (the async import worker create path, ADR-0053)', () => {
  it('imports a .md, deriving the title/slug from the filename, returns the articleId', async () => {
    const { prisma, articleCreate, versionCreate } = makePrisma();
    const result = await runImportJob(
      baseData({ originalname: 'network-guide.md' }),
      prisma,
    );

    // The single-file path now returns a discriminated result (`kind: 'single'`) so getStatus can
    // tell it from a `.zip` batch result without re-reading the job data (ADR-0059 §5).
    expect(result).toEqual({ kind: 'single', articleId: 'art1' });
    const data = articleCreate.mock.calls[0][0].data as {
      title: string;
      slug: string;
      content: string;
      authorId: string;
      publishedAt: Date | null;
      status: string;
    };
    expect(data.title).toBe('network guide');
    expect(data.slug).toBe('network-guide');
    expect(data.content).toContain('# Hello');
    expect(data.authorId).toBe(AUTHOR);
    expect(data.publishedAt).toBeNull();
    // Version 1 snapshot in the same transaction (ADR-0042).
    expect(versionCreate).toHaveBeenCalledTimes(1);
    expect(versionCreate.mock.calls[0][0]).toMatchObject({
      data: { version: 1, editedById: AUTHOR },
    });
  });

  it('reads a .txt body verbatim (content stored raw, SEC-003)', async () => {
    const { prisma, articleCreate } = makePrisma();
    await runImportJob(
      baseData({
        originalname: 'notes.txt',
        contentBase64: b64('line one\n<script>alert(1)</script>'),
      }),
      prisma,
    );
    const data = articleCreate.mock.calls[0][0].data as { content: string };
    expect(data.content).toContain('<script>alert(1)</script>');
  });

  it('indexes a PUBLISHED import (draft privacy means DRAFT is never indexed)', async () => {
    const index = jest.fn();
    const { prisma } = makePrisma();
    await runImportJob(
      baseData({ originalname: 'guide.md', status: 'PUBLISHED' }),
      prisma,
      index,
    );
    expect(index).toHaveBeenCalledTimes(1);
    expect(index).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'art1', status: 'PUBLISHED' }),
    );
  });

  it('does NOT index a DRAFT import', async () => {
    const index = jest.fn();
    const { prisma } = makePrisma();
    await runImportJob(baseData({ status: 'DRAFT' }), prisma, index);
    expect(index).not.toHaveBeenCalled();
  });

  it('throws on an empty file (no article is created)', async () => {
    const { prisma, articleCreate } = makePrisma();
    await expect(
      runImportJob(baseData({ contentBase64: b64('   \n  ') }), prisma),
    ).rejects.toThrow(/no .*text content/i);
    expect(articleCreate).not.toHaveBeenCalled();
  });

  it('parses a real .docx to markdown and creates the article (completed → articleId)', async () => {
    const { prisma, articleCreate } = makePrisma();
    const result = await runImportJob(
      baseData({
        originalname: 'sample.docx',
        contentBase64: fixture('sample.docx').toString('base64'),
      }),
      prisma,
    );
    expect(result).toEqual({ kind: 'single', articleId: 'art1' });
    const data = articleCreate.mock.calls[0][0].data as { content: string };
    expect(data.content).toContain('Datacenter Runbook');
  });

  it('auto-suffixes a derived slug that a live article already holds (AUD-046)', async () => {
    const { prisma, articleCreate } = makePrisma(['runbook', 'runbook-2']);
    await runImportJob(baseData({ originalname: 'runbook.md' }), prisma);
    const data = articleCreate.mock.calls[0][0].data as { slug: string };
    expect(data.slug).toBe('runbook-3');
  });

  it('keeps an explicit slug and fails with the slug-taken message when it is held (AUD-046)', async () => {
    const { prisma } = makePrisma(['runbook']);
    await expect(
      runImportJob(baseData({ slug: 'runbook' }), prisma),
    ).rejects.toThrow(IMPORT_SLUG_TAKEN_MESSAGE);
  });

  it('fails with the slug-derivation message on a title with no slug characters (AUD-046)', async () => {
    const { prisma, articleCreate } = makePrisma();
    await expect(
      runImportJob(baseData({ originalname: '日本語.md' }), prisma),
    ).rejects.toThrow(/Could not derive a slug/);
    expect(articleCreate).not.toHaveBeenCalled();
  });

  it('takes over earlier [[links]] to its slug, unresolved or left on a soft-deleted holder (AUD-101)', async () => {
    const { prisma, wikiLinkUpdateMany } = makePrisma();
    await runImportJob(baseData({ originalname: 'vpn-setup.md' }), prisma);
    expect(wikiLinkUpdateMany).toHaveBeenCalledWith({
      where: claimableWikiLinksWhere('vpn-setup'),
      data: { resolvedTargetId: 'art1' },
    });
  });

  it('never resolves a [[link]] to a soft-deleted article', async () => {
    const { prisma, wikiLinkCreateMany } = makePrisma(['live-one'], {
      deletedSlugs: ['gone'],
    });
    await runImportJob(
      baseData({ contentBase64: b64('See [[gone]] and [[live-one]]') }),
      prisma,
    );
    expect(wikiLinkCreateMany).toHaveBeenCalledWith({
      data: [
        { sourceArticleId: 'art1', targetSlug: 'gone', resolvedTargetId: null },
        {
          sourceArticleId: 'art1',
          targetSlug: 'live-one',
          resolvedTargetId: 'live-live-one',
        },
      ],
    });
  });
});

describe('runImportJob — a folder deleted while the job waited (AUD-023)', () => {
  it('locks the target folder FOR SHARE inside the transaction before creating', async () => {
    const { prisma, queryRaw, articleCreate } = makePrisma();
    await runImportJob(baseData(), prisma);
    const [sql, id] = queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      string,
    ];
    expect(sql.join('?')).toMatch(/FOR SHARE/);
    expect(id).toBe('c1');
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      articleCreate.mock.invocationCallOrder[0],
    );
  });

  it('fails the job with the folder-gone message and creates nothing', async () => {
    const { prisma, articleCreate } = makePrisma([], {
      deletedFolders: ['c1'],
    });
    await expect(runImportJob(baseData(), prisma)).rejects.toThrow(
      IMPORT_FOLDER_GONE_MESSAGE,
    );
    expect(articleCreate).not.toHaveBeenCalled();
  });
});
