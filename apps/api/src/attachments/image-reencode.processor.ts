import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import type { SandboxedJob } from 'bullmq';
import { PrismaClient } from '../../generated/prisma/client';
import {
  attachmentsTmpDir,
  blobPathFor,
  promoteBlob,
  sha256OfFile,
} from './attachment-storage';
import { RASTER_FORMATS, reencodeRaster } from './attachment-reencode';

/**
 * BullMQ SANDBOXED processor for the `attachment-reencode` queue (ADR-0082 §3 / ADR-0053). Raster
 * images (png/jpg/webp/gif) are RE-ENCODED via sharp after upload: rewriting the pixels strips
 * EXIF/GPS metadata (sharp drops metadata unless asked to keep it) and neutralizes polyglot files
 * (a JPEG that is also a script is pixels-only after re-encode). PDFs/documents are never touched.
 *
 * Sandboxed (a forked, heap-capped Node child — see attachments.constants.ts) because image
 * decoding allocates native memory proportional to attacker-supplied dimensions: a decompression
 * bomb kills THIS child, never the API (SEC-002; sharp's own `limitInputPixels` default is the
 * first line). BEST-EFFORT by contract: any failure logs and keeps the original blob — serving is
 * already hardened (nosniff + CSP sandbox), so a skipped re-encode is defense-in-depth lost, not a
 * hole opened. The job always COMPLETES with an outcome (attempts:1, nothing to retry).
 *
 * On success the blob is REPLACED content-addressed-style: new bytes → tmp → atomic promote to the
 * new sha path → row UPDATE (sha256/byteSize) → the OLD blob is unlinked only when no other row
 * (live or soft-deleted — this raw client has no soft-delete filter) still references it (dedup-safe).
 */

/** Job payload: which attachment to re-encode. (Local: `export =` forbids named exports.) */
interface ReencodeJobData {
  attachmentId: string;
}

interface ReencodeJobResult {
  ok: boolean;
  skipped?: string;
  error?: string;
}

let prismaSingleton: PrismaClient | undefined;

/** One PrismaClient per child, reused across jobs (no Nest DI here — the BullMQ sandbox contract). */
function getPrisma(): PrismaClient {
  if (!prismaSingleton) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    prismaSingleton = new PrismaClient({
      adapter: new PrismaPg({ connectionString }),
    });
  }
  return prismaSingleton;
}

const processor = async (
  job: SandboxedJob<ReencodeJobData>,
): Promise<ReencodeJobResult> => {
  const prisma = getPrisma();
  const row = await prisma.attachment.findFirst({
    where: { id: job.data.attachmentId, deletedAt: null },
  });
  if (!row) return { ok: true, skipped: 'attachment gone' };
  const format = RASTER_FORMATS[row.mimeType];
  if (!format) return { ok: true, skipped: `not a raster (${row.mimeType})` };

  const src = blobPathFor(row.sha256);
  const tmpDir = attachmentsTmpDir();
  const tmpPath = join(tmpDir, `reencode-${randomUUID()}`);
  try {
    await mkdir(tmpDir, { recursive: true });
    // Shared with the KB-import ingest so the EXIF-strip / polyglot-neutralization behaviour never
    // drifts between the two paths (see attachment-reencode.ts). `format` above already proved the
    // mimeType is a supported raster.
    await reencodeRaster(src, row.mimeType).toFile(tmpPath);

    const newSha = await sha256OfFile(tmpPath);
    const newSize = (await stat(tmpPath)).size;
    await promoteBlob(tmpPath, newSha);
    await prisma.attachment.update({
      where: { id: row.id },
      data: { sha256: newSha, byteSize: newSize },
    });
    if (newSha !== row.sha256) {
      // Reclaim the pre-encode blob unless something else (any row, incl. soft-deleted — the GC's
      // audit trail) still points at it. Dedup-safe by construction.
      const stillReferenced = await prisma.attachment.count({
        where: { sha256: row.sha256 },
      });
      if (stillReferenced === 0) {
        await rm(src, { force: true });
      }
    }
    return { ok: true };
  } catch (err) {
    // Best-effort: keep the original blob + row untouched; surface the reason in the job result.
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[attachment-reencode] keeping original for ${row.id}: ${message}`,
    );
    await rm(tmpPath, { force: true });
    return { ok: false, error: message };
  }
};

// The BullMQ sandbox contract: the compiled file's module value IS the handler (`export =` emits
// `module.exports = processor`, which the child loader resolves) — mirrors article-import.processor.
export = processor;
