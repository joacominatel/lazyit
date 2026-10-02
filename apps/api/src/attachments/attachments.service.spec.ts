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
const PURCHASE_ID = 'clpo00000000000000000001';

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
    groupBy: jest.Mock;
  };
  asset: { findFirst: jest.Mock };
  purchaseOrder: { findFirst: jest.Mock };
  purchaseOrderEvent: { create: jest.Mock };
  $transaction: jest.Mock;
  /** The client the transaction callback received — writes through it are atomic with the row. */
  tx: {
    attachment: PrismaMock['attachment'];
    purchaseOrderEvent: PrismaMock['purchaseOrderEvent'];
  };
};

/** What the budget accounting sees: existing rows, live or soft-deleted-at-some-time. */
type BudgetRow = { sha256: string; byteSize: number; deletedAt: Date | null };

describe('AttachmentsService (ADR-0082)', () => {
  let root: string;
  let prisma: PrismaMock;
  let budgetRows: BudgetRow[];
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
    budgetRows = [];
    prisma = {
      attachment: {
        create: jest.fn((args: { data: object }) => ({
          id: 'clatt0000000000000000000',
          ...args.data,
        })),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn((args: { data: object }) => ({ ...args.data })),
        // Functional fake of the budget aggregate: applies the service's OWN where clause
        // (live OR soft-deleted after the grace cutoff) to `budgetRows` and groups distinct-by-sha
        // — so the tests exercise the window logic, not just a canned sum.
        groupBy: jest.fn(
          (args: {
            where: { OR: [{ deletedAt: null }, { deletedAt: { gt: Date } }] };
          }) => {
            const cutoff = args.where.OR[1].deletedAt.gt;
            const bySha = new Map<string, number>();
            for (const row of budgetRows) {
              if (row.deletedAt !== null && row.deletedAt <= cutoff) continue;
              bySha.set(
                row.sha256,
                Math.max(bySha.get(row.sha256) ?? 0, row.byteSize),
              );
            }
            return [...bySha].map(([sha256, byteSize]) => ({
              sha256,
              _max: { byteSize },
            }));
          },
        ),
      },
      asset: { findFirst: jest.fn().mockResolvedValue({ id: ASSET_ID }) },
      purchaseOrder: {
        findFirst: jest.fn().mockResolvedValue({ id: PURCHASE_ID }),
      },
      purchaseOrderEvent: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(),
      tx: undefined as never,
    };
    // A distinct transaction client sharing the delegates: a write made through `tx` is in the transaction.
    const purchaseOrderEvent = { create: jest.fn().mockResolvedValue({}) };
    prisma.tx = { attachment: prisma.attachment, purchaseOrderEvent };
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
      cb(prisma.tx),
    );
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
      budgetRows.push({
        sha256: 'a'.repeat(64),
        byteSize: 1024 * 1024 - 5,
        deletedAt: null,
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

    it('counts soft-deleted-WITHIN-GRACE bytes against the budget (upload→delete→upload churn cannot stack blobs)', async () => {
      process.env.ATTACHMENTS_MAX_TOTAL_MB = '1';
      // Deleted a minute ago: the blob is still on disk until the daily GC + 24 h grace pass.
      budgetRows.push({
        sha256: 'a'.repeat(64),
        byteSize: 1024 * 1024 - 5,
        deletedAt: new Date(Date.now() - 60_000),
      });
      const file = await stageUpload(PDF_BYTES, 'again.pdf');
      await expect(
        service.upload('ASSET', ASSET_ID, file, HUMAN),
      ).rejects.toMatchObject({ status: 507 });
      expect(prisma.attachment.create).not.toHaveBeenCalled();
    });

    it('frees the budget once a soft delete ages past the GC grace (bytes reclaimed or about to be)', async () => {
      process.env.ATTACHMENTS_MAX_TOTAL_MB = '1';
      // Deleted 48 h ago — past the 24 h grace, the sweep has (or will have) unlinked the blob.
      budgetRows.push({
        sha256: 'a'.repeat(64),
        byteSize: 1024 * 1024 - 5,
        deletedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      });
      const file = await stageUpload(PDF_BYTES, 'fits-now.pdf');
      await expect(
        service.upload('ASSET', ASSET_ID, file, HUMAN),
      ).resolves.toMatchObject({ mimeType: 'application/pdf' });
    });

    it('counts a dedup-shared blob ONCE against the budget (distinct-by-sha256)', async () => {
      process.env.ATTACHMENTS_MAX_TOTAL_MB = '1';
      // Two live rows sharing one 700 KB blob = 700 KB on disk, not 1.4 MB — the upload fits.
      const shared = {
        sha256: 'b'.repeat(64),
        byteSize: 700 * 1024,
        deletedAt: null,
      };
      budgetRows.push(shared, { ...shared });
      const file = await stageUpload(PDF_BYTES, 'fits.pdf');
      await expect(
        service.upload('ASSET', ASSET_ID, file, HUMAN),
      ).resolves.toMatchObject({ mimeType: 'application/pdf' });
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

    it('rejects a service-account delete on an ASSET attachment (403 — write symmetry with upload)', async () => {
      await expect(
        service.remove('ASSET', ASSET_ID, 'clatt0000000000000000000', SA),
      ).rejects.toMatchObject({ status: 403 });
      expect(prisma.attachment.update).not.toHaveBeenCalled();
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
  describe('PURCHASE_ORDER documents (ADR-0099 §10, #1473)', () => {
    it('upload: the asset allowlist and cap; the row and DOCUMENT_ADDED commit in one transaction', async () => {
      const file = await stageUpload(PDF_BYTES, 'Factura A 0003.pdf');
      await service.upload('PURCHASE_ORDER', PURCHASE_ID, file, HUMAN);

      expect(prisma.purchaseOrder.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: PURCHASE_ID, deletedAt: null },
        }),
      );
      expect(prisma.attachment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          entityType: 'PURCHASE_ORDER',
          entityId: PURCHASE_ID,
          mimeType: 'application/pdf',
        }) as object,
      });
      expect(prisma.tx.purchaseOrderEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          purchaseOrderId: PURCHASE_ID,
          eventType: 'DOCUMENT_ADDED',
          performedById: UPLOADER,
          payload: {
            attachmentId: 'clatt0000000000000000000',
            originalName: 'Factura A 0003.pdf',
            label: null,
          },
        }) as object,
      });
    });

    it('upload: refuses a type outside the document allowlist (HTML disguised as pdf)', async () => {
      const file = await stageUpload(
        Buffer.from('<!doctype html><script>x</script>'),
        'invoice.pdf',
      );
      await expect(
        service.upload('PURCHASE_ORDER', PURCHASE_ID, file, HUMAN),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      expect(prisma.attachment.create).not.toHaveBeenCalled();
      expect(prisma.tx.purchaseOrderEvent.create).not.toHaveBeenCalled();
    });

    it('upload: a missing or archived purchase is a 404 — no row, no event, tmp cleared', async () => {
      prisma.purchaseOrder.findFirst.mockResolvedValue(null);
      const file = await stageUpload(PDF_BYTES, 'order.pdf');
      await expect(
        service.upload('PURCHASE_ORDER', PURCHASE_ID, file, HUMAN),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.attachment.create).not.toHaveBeenCalled();
      expect(await readdir(join(root, 'tmp'))).toEqual([]);
    });

    it('list and content are scoped to a live purchase (404 otherwise)', async () => {
      await service.list('PURCHASE_ORDER', PURCHASE_ID);
      expect(prisma.attachment.findMany).toHaveBeenCalledWith({
        where: { entityType: 'PURCHASE_ORDER', entityId: PURCHASE_ID },
        orderBy: { createdAt: 'desc' },
      });
      prisma.purchaseOrder.findFirst.mockResolvedValue(null);
      await expect(
        service.getContent(
          'PURCHASE_ORDER',
          PURCHASE_ID,
          'clatt0000000000000000000',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('remove: soft delete and DOCUMENT_REMOVED in one transaction; a service account is refused', async () => {
      prisma.attachment.findFirst.mockResolvedValue({
        id: 'clatt0000000000000000000',
        originalName: 'order.pdf',
      });
      await service.remove(
        'PURCHASE_ORDER',
        PURCHASE_ID,
        'clatt0000000000000000000',
        HUMAN,
      );
      expect(prisma.attachment.update).toHaveBeenCalledWith({
        where: { id: 'clatt0000000000000000000' },
        data: { deletedAt: expect.any(Date) as Date },
      });
      expect(prisma.tx.purchaseOrderEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventType: 'DOCUMENT_REMOVED',
          payload: {
            attachmentId: 'clatt0000000000000000000',
            originalName: 'order.pdf',
            label: null,
          },
        }) as object,
      });
      await expect(
        service.remove(
          'PURCHASE_ORDER',
          PURCHASE_ID,
          'clatt0000000000000000000',
          SA,
        ),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('an ASSET upload writes no purchase event', async () => {
      const file = await stageUpload(PDF_BYTES, 'warranty.pdf');
      await service.upload('ASSET', ASSET_ID, file, HUMAN);
      expect(prisma.tx.purchaseOrderEvent.create).not.toHaveBeenCalled();
    });
  });

  describe('document type label (ADR-0099 §10, #1476)', () => {
    const ATT = 'clatt0000000000000000000';

    it('upload: stores the trimmed label on the row and in DOCUMENT_ADDED; a blank one is no label', async () => {
      const file = await stageUpload(PDF_BYTES, 'remito.pdf');
      const row = await service.upload(
        'PURCHASE_ORDER',
        PURCHASE_ID,
        file,
        HUMAN,
        '  Delivery note ',
      );
      expect(row).toMatchObject({ label: 'Delivery note' });
      expect(prisma.tx.purchaseOrderEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventType: 'DOCUMENT_ADDED',
          payload: {
            attachmentId: ATT,
            originalName: 'remito.pdf',
            label: 'Delivery note',
          },
        }) as object,
      });

      const blank = await stageUpload(PDF_BYTES, 'warranty.pdf');
      await service.upload('ASSET', ASSET_ID, blank, HUMAN, '   ');
      const [, second] = prisma.attachment.create.mock.calls as [
        { data: Record<string, unknown> },
      ][];
      expect(second[0].data).not.toHaveProperty('label');
    });

    it('upload: an over-long label is a 400 — no row, no blob kept, tmp cleared', async () => {
      const file = await stageUpload(PDF_BYTES, 'invoice.pdf');
      await expect(
        service.upload('ASSET', ASSET_ID, file, HUMAN, 'x'.repeat(101)),
      ).rejects.toMatchObject({ status: 400 });
      expect(prisma.attachment.create).not.toHaveBeenCalled();
      expect(await readdir(join(root, 'tmp'))).toEqual([]);
    });

    it('edit on a purchase document: sets the label and logs DOCUMENT_UPDATED from → to, in one transaction', async () => {
      prisma.attachment.findFirst.mockResolvedValue({
        id: ATT,
        originalName: 'scan.pdf',
        label: 'Quote',
      });
      await service.updateLabel(
        'PURCHASE_ORDER',
        PURCHASE_ID,
        ATT,
        'Invoice',
        HUMAN,
      );
      expect(prisma.attachment.findFirst).toHaveBeenCalledWith({
        where: {
          id: ATT,
          entityType: 'PURCHASE_ORDER',
          entityId: PURCHASE_ID,
        },
      });
      expect(prisma.attachment.update).toHaveBeenCalledWith({
        where: { id: ATT },
        data: { label: 'Invoice' },
      });
      expect(prisma.tx.purchaseOrderEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          purchaseOrderId: PURCHASE_ID,
          eventType: 'DOCUMENT_UPDATED',
          performedById: UPLOADER,
          payload: {
            attachmentId: ATT,
            originalName: 'scan.pdf',
            label: { from: 'Quote', to: 'Invoice' },
          },
        }) as object,
      });
    });

    it('edit on an asset document clears with null and writes no purchase event; an unchanged label writes nothing', async () => {
      prisma.attachment.findFirst.mockResolvedValue({
        id: ATT,
        originalName: 'warranty.pdf',
        label: 'Warranty',
      });
      await service.updateLabel('ASSET', ASSET_ID, ATT, null, HUMAN);
      expect(prisma.attachment.update).toHaveBeenCalledWith({
        where: { id: ATT },
        data: { label: null },
      });
      expect(prisma.tx.purchaseOrderEvent.create).not.toHaveBeenCalled();

      prisma.attachment.update.mockClear();
      await service.updateLabel('ASSET', ASSET_ID, ATT, 'Warranty', HUMAN);
      expect(prisma.attachment.update).not.toHaveBeenCalled();
    });

    it('edit: 404 for a document of another parent or an archived purchase; 403 for a service account', async () => {
      prisma.attachment.findFirst.mockResolvedValue(null);
      await expect(
        service.updateLabel('ASSET', ASSET_ID, ATT, 'Invoice', HUMAN),
      ).rejects.toBeInstanceOf(NotFoundException);
      prisma.purchaseOrder.findFirst.mockResolvedValue(null);
      await expect(
        service.updateLabel('PURCHASE_ORDER', PURCHASE_ID, ATT, 'x', HUMAN),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.updateLabel('ASSET', ASSET_ID, ATT, 'Invoice', SA),
      ).rejects.toMatchObject({ status: 403 });
      expect(prisma.attachment.update).not.toHaveBeenCalled();
    });
  });
});
