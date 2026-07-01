import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HttpException,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { AttachmentsService } from './attachments.service';
import { blobPathFor } from './attachment-storage';

// Mock the generated Prisma client so the test never loads the real one (no DB) — and meilisearch,
// which ArticlesService pulls in transitively (ESM; jest can't transform it).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

const UPLOADER = '11111111-1111-4111-8111-111111111111';
const HUMAN = { kind: 'human', user: { id: UPLOADER } } as never;
const SA = {
  kind: 'service',
  serviceAccount: { id: 'sa_x' },
  permissions: new Set(),
} as never;

const ASSET_ID = 'classet000000000000000000';
const ARTICLE_ID = 'clart00000000000000000000';

const PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.7\n'),
  Buffer.from('fake pdf body'),
]);
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake png body'),
]);

function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

type PrismaMock = {
  attachment: {
    create: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    aggregate: jest.Mock;
  };
  asset: { findFirst: jest.Mock };
};

describe('AttachmentsService (ADR-0082)', () => {
  let root: string;
  let prisma: PrismaMock;
  let articles: { findOne: jest.Mock; assertAttachmentWritable: jest.Mock };
  let queue: { add: jest.Mock };
  let service: AttachmentsService;

  /** Drop the uploaded bytes into the tmp dir the multer diskStorage would use. */
  async function stageUpload(content: Buffer, originalname: string) {
    const dir = join(root, 'tmp');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `upload-${randomUUID()}`);
    await writeFile(path, content);
    return { path, size: content.length, originalname };
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazyit-attachments-'));
    process.env.ATTACHMENTS_DIR = root;
    delete process.env.ATTACHMENTS_MAX_TOTAL_MB;
    prisma = {
      attachment: {
        create: jest.fn((args: { data: object }) => ({
          id: 'clatt0000000000000000000',
          ...args.data,
        })),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn((args: { data: object }) => ({ ...args.data })),
        aggregate: jest.fn().mockResolvedValue({ _sum: { byteSize: 0 } }),
      },
      asset: { findFirst: jest.fn().mockResolvedValue({ id: ASSET_ID }) },
    };
    articles = {
      findOne: jest.fn().mockResolvedValue({ id: ARTICLE_ID }),
      assertAttachmentWritable: jest.fn().mockResolvedValue(undefined),
    };
    queue = { add: jest.fn().mockResolvedValue({ id: 'job1' }) };
    service = new AttachmentsService(
      prisma as never,
      articles as never,
      queue as never,
    );
  });

  afterEach(() => {
    delete process.env.ATTACHMENTS_DIR;
    delete process.env.ATTACHMENTS_MAX_TOTAL_MB;
  });

  describe('upload', () => {
    it('happy path (asset pdf): sniffs the server MIME, promotes the blob, inserts the row, clears tmp', async () => {
      const file = await stageUpload(PDF_BYTES, 'warranty.pdf');
      const row = await service.upload('ASSET', ASSET_ID, file, HUMAN);

      const expectedSha = sha256Of(PDF_BYTES);
      expect(prisma.attachment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          entityType: 'ASSET',
          entityId: ASSET_ID,
          sha256: expectedSha,
          byteSize: PDF_BYTES.length,
          mimeType: 'application/pdf', // server-derived, never the client's
          originalName: 'warranty.pdf',
          uploadedById: UPLOADER,
        }) as object,
      });
      expect(row).toMatchObject({ sha256: expectedSha });
      // Blob-first: the bytes sit at the content-addressed path; tmp is empty again.
      expect(existsSync(blobPathFor(expectedSha, root))).toBe(true);
      expect(await readdir(join(root, 'tmp'))).toEqual([]);
      // A PDF is never re-encoded.
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('enqueues the sandboxed re-encode for a raster image', async () => {
      const file = await stageUpload(PNG_BYTES, 'screen.png');
      await service.upload('ARTICLE', ARTICLE_ID, file, HUMAN);
      expect(articles.assertAttachmentWritable).toHaveBeenCalledWith(
        ARTICLE_ID,
        HUMAN,
      );
      expect(queue.add).toHaveBeenCalledWith(
        'reencode-image',
        { attachmentId: 'clatt0000000000000000000' },
        expect.anything(),
      );
    });

    it('rejects a fake .pdf that is really HTML (sniff) — no row, no blob, tmp cleared', async () => {
      const file = await stageUpload(
        Buffer.from('<!DOCTYPE html><script>alert(1)</script>'),
        'invoice.pdf',
      );
      await expect(
        service.upload('ASSET', ASSET_ID, file, HUMAN),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      expect(prisma.attachment.create).not.toHaveBeenCalled();
      expect(await readdir(join(root, 'tmp'))).toEqual([]);
    });

    it('rejects a type outside the SURFACE allowlist (a pdf is fine on an asset, not on an article)', async () => {
      const file = await stageUpload(PDF_BYTES, 'doc.pdf');
      await expect(
        service.upload('ARTICLE', ARTICLE_ID, file, HUMAN),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    });

    it('re-checks the per-file cap server-side (413)', async () => {
      const file = await stageUpload(PDF_BYTES, 'big.pdf');
      file.size = 26 * 1024 * 1024; // past the 25 MB asset cap
      await expect(
        service.upload('ASSET', ASSET_ID, file, HUMAN),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
      expect(prisma.attachment.create).not.toHaveBeenCalled();
    });

    it('rejects with a clean 507 when the total budget would be exceeded (never a 500/partial write)', async () => {
      process.env.ATTACHMENTS_MAX_TOTAL_MB = '1';
      prisma.attachment.aggregate.mockResolvedValue({
        _sum: { byteSize: 1024 * 1024 - 5 },
      });
      const file = await stageUpload(PDF_BYTES, 'one-more.pdf');
      await expect(
        service.upload('ASSET', ASSET_ID, file, HUMAN),
      ).rejects.toMatchObject({ status: 507 });
      expect(prisma.attachment.create).not.toHaveBeenCalled();
      // Nothing promoted, tmp discarded — no half-written blob anywhere.
      expect(await readdir(root)).toEqual(['tmp']);
      expect(await readdir(join(root, 'tmp'))).toEqual([]);
    });

    it('dedups by content: the same bytes on two parents share ONE blob (two rows, same sha)', async () => {
      const first = await stageUpload(PDF_BYTES, 'a.pdf');
      const second = await stageUpload(PDF_BYTES, 'b.pdf');
      await service.upload('ASSET', ASSET_ID, first, HUMAN);
      await service.upload('ASSET', 'classet111111111111111111', second, HUMAN);

      const sha = sha256Of(PDF_BYTES);
      expect(prisma.attachment.create).toHaveBeenCalledTimes(2);
      const shard = await readdir(join(root, sha.slice(0, 2)));
      expect(shard).toEqual([sha]); // exactly one blob
      expect(await readdir(join(root, 'tmp'))).toEqual([]); // both tmp copies gone
    });

    it('rejects a service-account uploader (403 — an uploader is a human)', async () => {
      const file = await stageUpload(PDF_BYTES, 'a.pdf');
      await expect(
        service.upload('ASSET', ASSET_ID, file, SA),
      ).rejects.toMatchObject({ status: 403 });
      expect(await readdir(join(root, 'tmp'))).toEqual([]);
    });

    it("propagates the article write gate's 404 and still discards the tmp bytes", async () => {
      articles.assertAttachmentWritable.mockRejectedValue(
        new NotFoundException('Article not found'),
      );
      const file = await stageUpload(PNG_BYTES, 'x.png');
      await expect(
        service.upload('ARTICLE', ARTICLE_ID, file, HUMAN),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(await readdir(join(root, 'tmp'))).toEqual([]);
    });
  });

  describe('getContent', () => {
    it('streams the blob with the STORED server-derived metadata', async () => {
      const file = await stageUpload(PDF_BYTES, 'warranty.pdf');
      const row = await service.upload('ASSET', ASSET_ID, file, HUMAN);
      prisma.attachment.findFirst.mockResolvedValue(row);

      const content = await service.getContent('ASSET', ASSET_ID, row.id);
      expect(content.mimeType).toBe('application/pdf');
      expect(content.byteSize).toBe(PDF_BYTES.length);
      expect(content.originalName).toBe('warranty.pdf');
      content.stream.destroy();
    });

    it('404s (never 403) when the article is not visible to the caller — no existence leak', async () => {
      articles.findOne.mockRejectedValue(
        new NotFoundException('Article not found'),
      );
      await expect(
        service.getContent('ARTICLE', ARTICLE_ID, 'clatt0000000000000000000'),
      ).rejects.toBeInstanceOf(NotFoundException);
      // The attachment row is never even looked up.
      expect(prisma.attachment.findFirst).not.toHaveBeenCalled();
    });

    it('404s when the row exists but the blob is gone (the documented DR gap degrades, never crashes)', async () => {
      prisma.attachment.findFirst.mockResolvedValue({
        id: 'clatt0000000000000000000',
        sha256: 'f'.repeat(64),
        mimeType: 'application/pdf',
        originalName: 'gone.pdf',
      });
      await expect(
        service.getContent('ASSET', ASSET_ID, 'clatt0000000000000000000'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('scopes the row lookup to the PARENT (an id alone never crosses parents)', async () => {
      prisma.attachment.findFirst.mockResolvedValue(null);
      await expect(
        service.getContent('ASSET', ASSET_ID, 'clatt0000000000000000000'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.attachment.findFirst).toHaveBeenCalledWith({
        where: {
          id: 'clatt0000000000000000000',
          entityType: 'ASSET',
          entityId: ASSET_ID,
        },
      });
    });
  });

  describe('remove', () => {
    it('soft-deletes (never a hard delete; the blob stays for the GC to adjudicate)', async () => {
      prisma.attachment.findFirst.mockResolvedValue({
        id: 'clatt0000000000000000000',
      });
      await service.remove(
        'ASSET',
        ASSET_ID,
        'clatt0000000000000000000',
        HUMAN,
      );
      expect(prisma.attachment.update).toHaveBeenCalledWith({
        where: { id: 'clatt0000000000000000000' },
        data: { deletedAt: expect.any(Date) as Date },
      });
    });

    it('enforces the article edit gate on delete', async () => {
      articles.assertAttachmentWritable.mockRejectedValue(
        new HttpException('Forbidden', 403),
      );
      await expect(
        service.remove(
          'ARTICLE',
          ARTICLE_ID,
          'clatt0000000000000000000',
          HUMAN,
        ),
      ).rejects.toMatchObject({ status: 403 });
    });
  });
});
