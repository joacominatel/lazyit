import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  runImportJob,
  type ImportedArticleRow,
  type ImportPrismaClient,
  type ImportTx,
} from './create-imported-article';
import type { ImportJobData } from './import-job.types';
import { IMPORT_SLUG_TAKEN_MESSAGE } from './import-job.constants';

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
 */
function makePrisma(liveSlugs: string[] = []) {
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
  const articleFindMany = jest.fn(
    (args: { where: { slug: { in: string[] } } }) =>
      Promise.resolve(
        args.where.slug.in
          .filter((slug) => liveSlugs.includes(slug))
          .map((slug) => ({ id: `live-${slug}`, slug })),
      ),
  );
  const wikiLinkUpdateMany = jest.fn(() => Promise.resolve({ count: 0 }));
  const versionCreate = jest.fn((args: { data: Record<string, unknown> }) =>
    Promise.resolve(args),
  );
  const tx = {
    article: { create: articleCreate, findMany: articleFindMany },
    articleVersion: { create: versionCreate },
    articleWikiLink: {
      createMany: jest.fn(() => Promise.resolve({ count: 0 })),
      updateMany: wikiLinkUpdateMany,
    },
  } as unknown as ImportTx;
  const prisma: ImportPrismaClient = {
    $transaction: <T>(fn: (t: ImportTx) => Promise<T>) => fn(tx),
  };
  return { prisma, articleCreate, versionCreate, wikiLinkUpdateMany };
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

  it('resolves earlier forward [[links]] to the new article (AUD-101)', async () => {
    const { prisma, wikiLinkUpdateMany } = makePrisma();
    await runImportJob(baseData({ originalname: 'vpn-setup.md' }), prisma);
    expect(wikiLinkUpdateMany).toHaveBeenCalledWith({
      where: { targetSlug: 'vpn-setup', resolvedTargetId: null },
      data: { resolvedTargetId: 'art1' },
    });
  });
});
