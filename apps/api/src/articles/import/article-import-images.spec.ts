import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import {
  runImportJob,
  type ImportedArticleRow,
  type ImportPrismaClient,
  type ImportTx,
  type ResolveImportedContent,
} from './create-imported-article';
import { rewriteEmbeddedImages } from '../../attachments/attachment-ingest';
import type { ImportJobData } from './import-job.types';

/**
 * End-to-end wiring for the KB-import image round-trip (ADR-0082 §5, issue #918): a `.docx` with an
 * embedded image → mammoth inlines it as a `data:` URI → `resolveContent` (the real
 * `rewriteEmbeddedImages`) ingests it into an attachment and rewrites the body ref → the version-1
 * snapshot is written with the final `attachment:<id>` body, never a `data:` URI. Runs without Redis
 * or a DB: an in-memory Prisma double for the article writes AND the attachment store, plus a temp
 * blob volume. sharp runs for real (the security-critical re-encode).
 */

const AUTHOR = '11111111-1111-1111-1111-111111111111';

/** A minimal but valid .docx carrying one embedded PNG (mirrors the OOXML shape mammoth reads). */
async function docxWithImage(): Promise<Buffer> {
  const png = await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 10, g: 120, b: 200 },
    },
  })
    .png()
    .toBuffer();

  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.folder('_rels')!.file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  const word = zip.folder('word')!;
  word.folder('media')!.file('image1.png', png);
  word.folder('_rels')!.file(
    'document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`,
  );
  word.file(
    'document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>
<w:p><w:r><w:t>Runbook with a screenshot</w:t></w:r></w:p>
<w:p><w:r><w:drawing><wp:inline><wp:extent cx="9525" cy="9525"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
</w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Prisma double: records article create/update + version create, and owns an attachment store. */
function makePrisma(opts?: { failVersion?: boolean }) {
  let content = '';
  const attachmentRows: Array<{
    id: string;
    entityId: string;
    sha256: string;
    byteSize: number;
  }> = [];
  let attSeq = 0;
  const versionCreate = jest.fn((args: { data: Record<string, unknown> }) =>
    Promise.resolve(args),
  );
  const articleUpdate = jest.fn((args: { data: { content: string } }) => {
    content = args.data.content;
    return Promise.resolve(args);
  });
  const articleCreate = jest.fn(
    (args: {
      data: {
        slug: string;
        title: string;
        content: string;
        status: string;
        categoryId: string;
      };
    }): Promise<ImportedArticleRow> => {
      content = args.data.content;
      return Promise.resolve({
        id: 'art1',
        slug: args.data.slug,
        title: args.data.title,
        content: args.data.content,
        excerpt: null,
        status: args.data.status as ImportedArticleRow['status'],
        categoryId: args.data.categoryId,
      });
    },
  );
  // The TRANSACTIONAL attachment client lives on `tx` (issue #918 fix): the round-trip mints rows on
  // this client so they share the article transaction. `create` pushes to the shared store and
  // `groupBy` reads it back (read-your-writes within the tx — the budget accumulates across images).
  const attachment = {
    // eslint-disable-next-line @typescript-eslint/require-await
    groupBy: async () => {
      const bySha = new Map<string, number>();
      for (const r of attachmentRows) {
        bySha.set(r.sha256, Math.max(bySha.get(r.sha256) ?? 0, r.byteSize));
      }
      return [...bySha.values()].map((v) => ({ _max: { byteSize: v } }));
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    create: async (args: {
      data: { entityId: string; sha256: string; byteSize: number };
    }) => {
      const id = `clatt${String(++attSeq).padStart(20, '0')}`;
      attachmentRows.push({ id, ...args.data });
      return { id };
    },
  };
  const tx = {
    article: {
      create: articleCreate,
      update: articleUpdate,
      findMany: jest.fn(() => Promise.resolve([])),
    },
    articleVersion: {
      create: opts?.failVersion
        ? jest.fn(() => Promise.reject(new Error('forced tx failure')))
        : versionCreate,
    },
    articleWikiLink: {
      createMany: jest.fn(() => Promise.resolve({ count: 0 })),
    },
    attachment,
  } as unknown as ImportTx;
  // Model interactive-transaction atomicity: attachment rows written during a FAILED transaction are
  // rolled back (truncated to the pre-tx mark), exactly as Prisma discards `tx` writes on abort.
  const prisma: ImportPrismaClient = {
    $transaction: async <T>(fn: (t: ImportTx) => Promise<T>): Promise<T> => {
      const mark = attachmentRows.length;
      try {
        return await fn(tx);
      } catch (err) {
        attachmentRows.length = mark;
        throw err;
      }
    },
  };
  return {
    prisma,
    attachmentRows,
    versionCreate,
    articleUpdate,
    finalContent: () => content,
  };
}

const jobData = (docx: Buffer): ImportJobData => ({
  originalname: 'runbook.docx',
  contentBase64: docx.toString('base64'),
  categoryId: 'c1',
  status: 'DRAFT',
  authorId: AUTHOR,
});

beforeEach(async () => {
  process.env.ATTACHMENTS_DIR = await mkdtemp(join(tmpdir(), 'att-import-'));
  delete process.env.ATTACHMENTS_MAX_TOTAL_MB;
});

afterEach(() => {
  delete process.env.ATTACHMENTS_DIR;
  delete process.env.ATTACHMENTS_MAX_TOTAL_MB;
});

describe('KB import image round-trip (issue #918)', () => {
  it('extracts a .docx embedded image into one attachment and rewrites the body to attachment:<id>', async () => {
    const h = makePrisma();
    const resolveContent: ResolveImportedContent = async (
      articleId,
      body,
      tx,
    ) => (await rewriteEmbeddedImages(tx, articleId, AUTHOR, body)).content;

    const result = await runImportJob(
      jobData(await docxWithImage()),
      h.prisma,
      undefined,
      resolveContent,
    );

    expect(result).toEqual({ kind: 'single', articleId: 'art1' });
    // Exactly one attachment was minted, bound to the article.
    expect(h.attachmentRows).toHaveLength(1);
    expect(h.attachmentRows[0].entityId).toBe('art1');
    // The article body was updated to the ref-only form, and the v1 snapshot froze the SAME body.
    expect(h.articleUpdate).toHaveBeenCalledTimes(1);
    const finalBody = h.finalContent();
    expect(finalBody).toContain(`attachment:${h.attachmentRows[0].id}`);
    expect(finalBody).not.toContain('data:image');
    const versionContent = (
      h.versionCreate.mock.calls[0][0] as { data: { content: string } }
    ).data.content;
    expect(versionContent).toBe(finalBody);
  });

  it('is a no-op for a body with no embedded images (no attachment, no update)', async () => {
    const h = makePrisma();
    const resolveContent: ResolveImportedContent = async (
      articleId,
      body,
      tx,
    ) => (await rewriteEmbeddedImages(tx, articleId, AUTHOR, body)).content;

    // A plain .md with no images.
    const data: ImportJobData = {
      ...jobData(Buffer.from('')),
      originalname: 'plain.md',
      contentBase64: Buffer.from('# Title\n\nJust text.').toString('base64'),
    };
    const result = await runImportJob(
      data,
      h.prisma,
      undefined,
      resolveContent,
    );

    expect(result).toEqual({ kind: 'single', articleId: 'art1' });
    expect(h.attachmentRows).toHaveLength(0);
    expect(h.articleUpdate).not.toHaveBeenCalled();
  });

  it('leaves NO committed attachment row when the create transaction rolls back (#918 budget-leak fix)', async () => {
    // Force the transaction to abort AFTER the image is ingested (version create throws). Because the
    // attachment row was minted on the transaction client, it must roll back with the article — no
    // orphan row survives to count against the budget (which the GC could never reclaim).
    const h = makePrisma({ failVersion: true });
    const resolveContent: ResolveImportedContent = async (
      articleId,
      body,
      tx,
    ) => (await rewriteEmbeddedImages(tx, articleId, AUTHOR, body)).content;

    await expect(
      runImportJob(
        jobData(await docxWithImage()),
        h.prisma,
        undefined,
        resolveContent,
      ),
    ).rejects.toThrow(/forced tx failure/);

    // The row was staged on `tx` (so the ingest saw it), but the rollback discarded it.
    expect(h.attachmentRows).toHaveLength(0);
  });
});
