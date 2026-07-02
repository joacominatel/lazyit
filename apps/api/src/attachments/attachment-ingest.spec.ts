import { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  AttachmentBudgetExceededError,
  MAX_IMPORT_IMAGES_PER_ARTICLE,
  ingestArticleImage,
  rewriteEmbeddedImages,
} from './attachment-ingest';
import { blobPathFor } from './attachment-storage';

// The ingest is DI-free (it runs in the sandboxed import child), so the spec drives it with a plain
// in-memory Prisma double + a temp blob volume — no Nest, no DB, no Redis. sharp runs for real (the
// re-encode is the security-critical step under test), so images must be genuinely decodable.

const ARTICLE_ID = 'clart00000000000000000000';
const AUTHOR = '11111111-1111-4111-8111-111111111111';

interface StoredRow {
  id: string;
  sha256: string;
  byteSize: number;
  entityId: string;
  mimeType: string;
}

/** A minimal in-memory stand-in for the child's raw PrismaClient (only `attachment` is used). */
function makePrisma() {
  const rows: StoredRow[] = [];
  let seq = 0;
  return {
    rows,
    attachment: {
      // Distinct-by-sha256 max byteSize — matches the real budget accounting.
      // eslint-disable-next-line @typescript-eslint/require-await
      groupBy: async () => {
        const bySha = new Map<string, number>();
        for (const r of rows) {
          bySha.set(r.sha256, Math.max(bySha.get(r.sha256) ?? 0, r.byteSize));
        }
        return [...bySha.values()].map((v) => ({ _max: { byteSize: v } }));
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      create: async (args: { data: Omit<StoredRow, 'id'> }) => {
        const id = `clatt${String(++seq).padStart(20, '0')}`;
        rows.push({ id, ...args.data });
        return { id };
      },
    },
  };
}

/** A real, decodable raster of the given format (sharp encodes it, so the re-encode round-trips). */
async function realImage(
  format: 'png' | 'jpeg' | 'webp' | 'gif',
): Promise<Buffer> {
  return sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 200, g: 30, b: 30 },
    },
  })
    .toFormat(format)
    .toBuffer();
}

function dataUri(mime: string, bytes: Buffer): string {
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

beforeEach(async () => {
  process.env.ATTACHMENTS_DIR = await mkdtemp(join(tmpdir(), 'att-ingest-'));
  delete process.env.ATTACHMENTS_MAX_TOTAL_MB;
});

afterEach(() => {
  delete process.env.ATTACHMENTS_DIR;
  delete process.env.ATTACHMENTS_MAX_TOTAL_MB;
});

describe('ingestArticleImage', () => {
  it('sniffs, re-encodes and stores a real PNG, minting one attachment bound to the article', async () => {
    const prisma = makePrisma();
    const png = await realImage('png');
    const result = await ingestArticleImage(prisma, ARTICLE_ID, AUTHOR, {
      buffer: png,
      originalname: 'import-image.png',
    });

    expect(result.ok).toBe(true);
    expect(prisma.rows).toHaveLength(1);
    const row = prisma.rows[0];
    expect(row.entityId).toBe(ARTICLE_ID);
    expect(row.mimeType).toBe('image/png');
    // The blob exists on disk, keyed by the sha256 of the RE-ENCODED bytes.
    expect(existsSync(blobPathFor(row.sha256))).toBe(true);
  });

  it('rejects an SVG data payload (stored-XSS red line) — no attachment, no blob', async () => {
    const prisma = makePrisma();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const result = await ingestArticleImage(prisma, ARTICLE_ID, AUTHOR, {
      buffer: svg,
      originalname: 'import-image.svg+xml',
    });

    expect(result.ok).toBe(false);
    expect(prisma.rows).toHaveLength(0);
  });

  it('rejects a non-image (declared-png but garbage bytes) — never persists raw bytes', async () => {
    const prisma = makePrisma();
    const result = await ingestArticleImage(prisma, ARTICLE_ID, AUTHOR, {
      buffer: Buffer.from('this is not an image at all'),
      originalname: 'import-image.png',
    });

    expect(result.ok).toBe(false);
    expect(prisma.rows).toHaveLength(0);
  });

  it('throws when the storage budget would be exceeded (never a silent half-import)', async () => {
    const prisma = makePrisma();
    process.env.ATTACHMENTS_MAX_TOTAL_MB = '1';
    // Pretend the store already holds ~1 MB, so any further byte breaches the 1 MB cap.
    prisma.rows.push({
      id: 'seed',
      sha256: 'a'.repeat(64),
      byteSize: 1024 * 1024,
      entityId: 'other',
      mimeType: 'image/png',
    });

    const png = await realImage('png');
    await expect(
      ingestArticleImage(prisma, ARTICLE_ID, AUTHOR, {
        buffer: png,
        originalname: 'import-image.png',
      }),
    ).rejects.toBeInstanceOf(AttachmentBudgetExceededError);
    // Only the seed row remains — nothing was persisted past the budget guard.
    expect(prisma.rows).toHaveLength(1);
  });
});

describe('rewriteEmbeddedImages', () => {
  it('turns a data-URI image in a Markdown body into an attachment: ref', async () => {
    const prisma = makePrisma();
    const png = await realImage('png');
    const body = `# Runbook\n\nBefore\n\n![screenshot](${dataUri('image/png', png)})\n\nAfter`;

    const out = await rewriteEmbeddedImages(prisma, ARTICLE_ID, AUTHOR, body);

    expect(out.ingested).toBe(1);
    expect(out.dropped).toBe(0);
    expect(prisma.rows).toHaveLength(1);
    expect(out.content).toContain(
      `![screenshot](attachment:${prisma.rows[0].id})`,
    );
    // The stored body must never retain a data: URI (the #917 refs-only guarantee).
    expect(out.content).not.toContain('data:image');
  });

  it('leaves a body with no embedded images completely untouched (zero regression)', async () => {
    const prisma = makePrisma();
    const body = '# Plain\n\nNo images here, only [[wiki-links]] and text.';

    const out = await rewriteEmbeddedImages(prisma, ARTICLE_ID, AUTHOR, body);

    expect(out).toEqual({ content: body, ingested: 0, dropped: 0 });
    expect(prisma.rows).toHaveLength(0);
  });

  it('drops a rejected (SVG) embedded image without leaving a data: URI in the body', async () => {
    const prisma = makePrisma();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const body = `Text ![diagram](${dataUri('image/svg+xml', svg)}) more text`;

    const out = await rewriteEmbeddedImages(prisma, ARTICLE_ID, AUTHOR, body);

    expect(out.ingested).toBe(0);
    expect(out.dropped).toBe(1);
    expect(prisma.rows).toHaveLength(0);
    expect(out.content).not.toContain('data:image');
    expect(out.content).toContain('Text  more text');
  });

  it('leaves external https:// image URLs untouched (not downloaded — ADR-0082 §5)', async () => {
    const prisma = makePrisma();
    const body = 'See ![remote](https://example.com/pic.png) here.';

    const out = await rewriteEmbeddedImages(prisma, ARTICLE_ID, AUTHOR, body);

    expect(out).toEqual({ content: body, ingested: 0, dropped: 0 });
    expect(prisma.rows).toHaveLength(0);
  });

  it('caps the number of ingested images per article, dropping the overflow', async () => {
    const prisma = makePrisma();
    const png = await realImage('png');
    const uri = dataUri('image/png', png);
    const count = MAX_IMPORT_IMAGES_PER_ARTICLE + 3;
    const body = Array.from(
      { length: count },
      (_, i) => `![img${i}](${uri})`,
    ).join('\n\n');

    const out = await rewriteEmbeddedImages(prisma, ARTICLE_ID, AUTHOR, body);

    expect(out.ingested).toBe(MAX_IMPORT_IMAGES_PER_ARTICLE);
    expect(out.dropped).toBe(3);
    expect(prisma.rows).toHaveLength(MAX_IMPORT_IMAGES_PER_ARTICLE);
    expect(out.content).not.toContain('data:image');
  });

  it('re-encodes a real JPEG data URI into a stored image/jpeg attachment', async () => {
    const prisma = makePrisma();
    const jpeg = await realImage('jpeg');
    const body = `![photo](${dataUri('image/jpeg', jpeg)})`;

    const out = await rewriteEmbeddedImages(prisma, ARTICLE_ID, AUTHOR, body);

    expect(out.ingested).toBe(1);
    expect(prisma.rows[0].mimeType).toBe('image/jpeg');
    expect(out.content).toBe(`![photo](attachment:${prisma.rows[0].id})`);
  });
});
