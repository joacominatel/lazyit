import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  runImportJob,
  type ImportedArticleRow,
  type ImportPrismaClient,
  type ImportTx,
} from './create-imported-article';
import type { ImportJobData } from './import-job.types';

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

/** A Prisma double that records the writes and echoes a created row back from the create args. */
function makePrisma() {
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
      Promise.resolve({
        id: 'art1',
        slug: args.data.slug,
        title: args.data.title,
        content: args.data.content,
        excerpt: null,
        status: args.data.status as ImportedArticleRow['status'],
        categoryId: args.data.categoryId,
      }),
  );
  const versionCreate = jest.fn((args: { data: Record<string, unknown> }) =>
    Promise.resolve(args),
  );
  const tx = {
    article: { create: articleCreate },
    articleVersion: { create: versionCreate },
  } as unknown as ImportTx;
  const prisma: ImportPrismaClient = {
    $transaction: <T>(fn: (t: ImportTx) => Promise<T>) => fn(tx),
  };
  return { prisma, articleCreate, versionCreate };
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
});
