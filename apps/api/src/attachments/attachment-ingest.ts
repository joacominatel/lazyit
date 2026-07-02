import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ARTICLE_IMAGE_MAX_MB, ARTICLE_IMAGE_MIME_TYPES } from '@lazyit/shared';
import {
  ATTACHMENTS_GC_GRACE_MS,
  maxTotalAttachmentBytes,
} from './attachments.constants';
import {
  attachmentsTmpDir,
  promoteBlob,
  sha256OfFile,
} from './attachment-storage';
import { sniffAttachment } from './magic-bytes';
import { RASTER_FORMATS, reencodeRaster } from './attachment-reencode';

/**
 * DI-free ingest of embedded KB-import images through the attachments pipeline (ADR-0082 §5 — the
 * follow-up to the #917 UX slice). The KB importer discards images today; this turns each image the
 * import embeds into a real `Attachment` bound to the article, and the caller rewrites the body ref to
 * `![alt](attachment:<id>)` (the ref #917's renderer resolves).
 *
 * WHY here (not `AttachmentsService.upload`): the importer runs INSIDE a forked, heap-capped BullMQ
 * sandboxed child (SEC-002 / ADR-0053) with a plain PrismaClient and NO Nest DI — it cannot reach the
 * Nest service. So this module orchestrates the SAME audited primitives the service uses (the
 * `magic-bytes` sniff, the `attachment-storage` blob writer, the `attachment-reencode` sharp pipeline,
 * the `attachments.constants` budget) over a plain client. The untrusted bytes therefore still flow
 * through sniff → allowlist → re-encode → quota exactly as an upload does — just in the child that is
 * already the isolation boundary for the hostile parse.
 *
 * SECURITY (the load-bearing invariants — this is the untrusted-bytes path):
 *  - The type is decided by the magic-byte SNIFF, never the data-URI's declared MIME. SVG and HTML
 *    are rejected outright (stored-XSS red line, ADR-0082).
 *  - Only RE-ENCODED bytes ever reach the blob store. We re-encode the decoded Buffer FIRST and
 *    persist that — raw imported bytes are never written to a permanent blob (stronger than the upload
 *    path, which persists the sniffed original and re-encodes asynchronously).
 *  - The per-instance storage budget (`ATTACHMENTS_MAX_TOTAL_MB`) is enforced before each blob lands;
 *    a breach THROWS so the caller fails the whole import (never a silent half-import).
 *  - The number of images per article is capped ({@link MAX_IMPORT_IMAGES_PER_ARTICLE}) so a body
 *    packed with thousands of tiny data URIs can't mint thousands of blobs/rows.
 */

/**
 * Ceiling on embedded images ingested per imported article. A body packed with thousands of tiny
 * data-URI images could otherwise mint thousands of blobs + rows (a zip-bomb-shaped cost even inside
 * the upload-size cap). Dozens of screenshots per runbook is already generous for a 5–20-person team;
 * extras are dropped (the body still loses their data: URIs). Bounds the fan-out, not correctness.
 */
// ponytail: a fixed ceiling, not a config knob — no operator has asked to tune it and 50 is roomy.
export const MAX_IMPORT_IMAGES_PER_ARTICLE = 50;

/** How many head bytes the sniff reads (mirrors `AttachmentsService`/`readFileHead`'s default). */
const SNIFF_HEAD_BYTES = 4100;

/** The tiny slice of Prisma the ingest path needs — satisfied structurally by the child's PrismaClient. */
export interface AttachmentIngestPrisma {
  attachment: {
    groupBy(args: {
      by: ['sha256'];
      where: { OR: Array<{ deletedAt: null } | { deletedAt: { gt: Date } }> };
      _max: { byteSize: true };
      orderBy: { sha256: 'asc' };
    }): Promise<Array<{ _max: { byteSize: number | null } }>>;
    create(args: {
      data: {
        entityType: 'ARTICLE';
        entityId: string;
        sha256: string;
        byteSize: number;
        mimeType: string;
        originalName: string;
        uploadedById: string;
      };
    }): Promise<{ id: string }>;
  };
}

/**
 * The total storage budget is exceeded (ADR-0082 §7). THROWN (not a per-image skip) so the caller
 * fails the whole import: a malicious/oversized import must not silently drop images once the disk is
 * full. The message carries "attachment storage is full" so the import status mapper surfaces it.
 */
export class AttachmentBudgetExceededError extends Error {
  constructor(maxBytes: number) {
    super(
      `Attachment storage is full (the ${Math.floor(
        maxBytes / (1024 * 1024),
      )} MB total limit would be exceeded). Ask your administrator to free space or raise ATTACHMENTS_MAX_TOTAL_MB.`,
    );
    this.name = 'AttachmentBudgetExceededError';
  }
}

/**
 * Assert the incoming blob fits the single-host storage budget (ADR-0082 §7). Mirrors
 * `AttachmentsService.assertWithinBudget`, minus the `includeSoftDeleted` extension arg: the sandbox
 * child's raw PrismaClient has no soft-delete extension, so its `groupBy` already sees every row and
 * the `where` re-bounds the sum to the not-yet-reclaimed window (live rows + rows soft-deleted inside
 * the GC grace, still on disk). Summed DISTINCT-by-sha256 so dedup-shared blobs count once.
 */
export async function assertWithinAttachmentBudget(
  prisma: AttachmentIngestPrisma,
  nextBytes: number,
): Promise<void> {
  const max = maxTotalAttachmentBytes();
  const graceCutoff = new Date(Date.now() - ATTACHMENTS_GC_GRACE_MS);
  const blobs = await prisma.attachment.groupBy({
    by: ['sha256'],
    where: { OR: [{ deletedAt: null }, { deletedAt: { gt: graceCutoff } }] },
    _max: { byteSize: true },
    orderBy: { sha256: 'asc' },
  });
  const used = blobs.reduce((sum, b) => sum + (b._max.byteSize ?? 0), 0);
  if (used + nextBytes > max) {
    throw new AttachmentBudgetExceededError(max);
  }
}

/** Result of ingesting one image: the minted attachment id, or a short skip reason (never thrown). */
export type IngestImageResult =
  | { ok: true; attachmentId: string }
  | { ok: false; reason: string };

/**
 * Ingest ONE decoded image through the full attachments pipeline and mint its `Attachment` row bound
 * to `articleId`: per-file cap → magic-byte sniff → ARTICLE-surface allowlist → sharp re-encode →
 * total-budget check on the RE-ENCODED size → content-addressed blob (blob-first) → row.
 *
 * Returns the attachment id on success, or `{ ok: false, reason }` for an image that is not an
 * accepted inline raster (SVG/HTML/non-image/oversized) or that sharp could not process — a single
 * bad image is skipped, never fatal. A BUDGET breach is the one hard failure: it THROWS
 * {@link AttachmentBudgetExceededError}. (An OOM decompression-bomb image kills the sandboxed child
 * instead, per SEC-002 — never reaching a graceful return here.)
 */
export async function ingestArticleImage(
  prisma: AttachmentIngestPrisma,
  articleId: string,
  uploadedById: string,
  image: { buffer: Buffer; originalname: string },
): Promise<IngestImageResult> {
  // 1. Per-file cap — bound the decode before sharp touches attacker-controlled dimensions.
  if (image.buffer.length > ARTICLE_IMAGE_MAX_MB * 1024 * 1024) {
    return {
      ok: false,
      reason: `over the ${ARTICLE_IMAGE_MAX_MB} MB inline-image limit`,
    };
  }
  // 2. Magic-byte sniff — CONTENT decides the type (never the data-URI's declared MIME). SVG/HTML are
  //    rejected outright inside the sniff; a non-image type fails the ARTICLE allowlist below.
  const sniff = sniffAttachment(
    image.buffer.subarray(0, SNIFF_HEAD_BYTES),
    image.originalname,
  );
  if (!sniff.ok) return { ok: false, reason: sniff.reason };
  if (
    !(ARTICLE_IMAGE_MIME_TYPES as readonly string[]).includes(sniff.mimeType)
  ) {
    return {
      ok: false,
      reason: `${sniff.mimeType} is not an inline image type`,
    };
  }
  // Every ARTICLE image type is a raster we re-encode; defensive guard on the shared format map.
  if (!RASTER_FORMATS[sniff.mimeType]) {
    return { ok: false, reason: `${sniff.mimeType} cannot be re-encoded` };
  }

  // 3. Re-encode FIRST (in this sandboxed child) — only these safe bytes ever hit the blob store.
  let reencoded: Buffer;
  try {
    reencoded = await reencodeRaster(image.buffer, sniff.mimeType).toBuffer();
  } catch {
    // Corrupt/hostile-but-not-OOM image: drop it, never fail the whole import (a bomb OOMs the child).
    return { ok: false, reason: 'the image could not be processed' };
  }

  // 4. Budget check on the ACTUAL persisted (re-encoded) size — a breach fails the import (throws).
  await assertWithinAttachmentBudget(prisma, reencoded.length);

  // 5. Blob-first content-addressed write, then the row (ADR-0082 §3). The tmp file is always removed.
  const tmpDir = attachmentsTmpDir();
  const tmpPath = join(tmpDir, `import-${randomUUID()}`);
  try {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(tmpPath, reencoded);
    const sha256 = await sha256OfFile(tmpPath);
    await promoteBlob(tmpPath, sha256);
    const row = await prisma.attachment.create({
      data: {
        entityType: 'ARTICLE',
        entityId: articleId,
        sha256,
        byteSize: reencoded.length,
        mimeType: sniff.mimeType,
        originalName: image.originalname,
        uploadedById,
      },
    });
    return { ok: true, attachmentId: row.id };
  } finally {
    await rm(tmpPath, { force: true });
  }
}

/**
 * Matches a Markdown image whose URL is a base64 `data:` image URI: `![alt](data:image/png;base64,…)`.
 * This is the ONE embedded-bytes form we handle — and it covers both sources:
 *  - `.docx`: mammoth's default image handler inlines every embedded `word/media/*` image as exactly
 *    this data URI in the markdown it produces (verified against mammoth 1.x `images.dataUri`);
 *  - hand-written `.md`/`.txt`: an author can paste the same inline data URI.
 * External `https://` image URLs are deliberately NOT matched — they are left in the body untouched
 * and the renderer drops them (ADR-0082 §5 "external image URLs restricted out"; no SSRF surface).
 * The base64 payload contains no `)` or whitespace, so `[^)\s]+` captures it up to the closing paren.
 */
const DATA_URI_IMAGE =
  /!\[([^\]]*)\]\(\s*(data:image\/[a-zA-Z0-9.+-]+;base64,[^)\s]+)\s*\)/gi;

/** Declared data-URI subtype → the file extension the sniff's extension-agreement check expects. */
const DATA_URI_EXT: Record<string, string> = {
  png: 'png',
  jpeg: 'jpg',
  jpg: 'jpg',
  gif: 'gif',
  webp: 'webp',
};

/**
 * Decode a `data:image/<subtype>;base64,<b64>` URI to bytes + a synthetic filename whose extension
 * matches the declared subtype (so the sniff's extension-agreement check can run — the sniff still
 * decides the REAL type from content). An unknown subtype maps to itself, which no allowlisted
 * signature will agree with → the image is safely dropped. Returns null on empty/undecodable base64.
 */
function decodeDataUri(
  uri: string,
): { buffer: Buffer; filename: string } | null {
  const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(uri);
  if (!m) return null;
  const subtype = m[1].toLowerCase();
  const ext = DATA_URI_EXT[subtype] ?? subtype;
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length === 0) return null;
  return { buffer, filename: `import-image.${ext}` };
}

/** The outcome of rewriting a body's embedded images: the new body + counts for the batch report. */
export interface RewriteImagesResult {
  /** The body with every `data:` image ref turned into `attachment:<id>` or dropped. */
  content: string;
  /** Images turned into attachment refs. */
  ingested: number;
  /** Images removed (rejected type, re-encode failure, or over the per-article ceiling). */
  dropped: number;
}

/**
 * Extract every embedded `data:` image from a produced Markdown body, ingest each through
 * {@link ingestArticleImage} bound to `articleId`, and rewrite the body so each becomes
 * `![alt](attachment:<id>)` (ADR-0082 §5). A rejected/failed/over-ceiling image is DROPPED — the body
 * never retains a `data:` URI (preserving #917's "refs are the only image mechanism" guarantee by
 * construction). A body with no embedded `data:` image is returned untouched (the common path — zero
 * regression). A budget breach propagates (throws) so the caller fails the whole import.
 */
export async function rewriteEmbeddedImages(
  prisma: AttachmentIngestPrisma,
  articleId: string,
  uploadedById: string,
  markdown: string,
): Promise<RewriteImagesResult> {
  DATA_URI_IMAGE.lastIndex = 0;
  if (!DATA_URI_IMAGE.test(markdown)) {
    return { content: markdown, ingested: 0, dropped: 0 };
  }

  // Collect matches first — the async ingest can't run inside `String.replace`. Splice replacements
  // back-to-front so earlier indices stay valid.
  DATA_URI_IMAGE.lastIndex = 0;
  const matches = [...markdown.matchAll(DATA_URI_IMAGE)];
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  let ingested = 0;
  let dropped = 0;

  for (const match of matches) {
    const start = match.index;
    const end = start + match[0].length;
    const alt = match[1] ?? '';

    if (ingested >= MAX_IMPORT_IMAGES_PER_ARTICLE) {
      // Over the per-article ceiling → drop (never leave a data: URI in the stored body).
      replacements.push({ start, end, text: '' });
      dropped++;
      continue;
    }

    const decoded = decodeDataUri(match[2]);
    const result = decoded
      ? await ingestArticleImage(prisma, articleId, uploadedById, {
          buffer: decoded.buffer,
          originalname: decoded.filename,
        })
      : ({ ok: false, reason: 'undecodable data URI' } as const);

    if (result.ok) {
      replacements.push({
        start,
        end,
        text: `![${alt}](attachment:${result.attachmentId})`,
      });
      ingested++;
    } else {
      // Rejected/failed → drop the image (mirrors how external URLs are dropped; never keep data:).
      replacements.push({ start, end, text: '' });
      dropped++;
    }
  }

  let content = markdown;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i];
    content = content.slice(0, r.start) + r.text + content.slice(r.end);
  }
  return { content, ingested, dropped };
}
