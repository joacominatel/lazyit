import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { diskStorage, type StorageEngine } from 'multer';
import { ATTACHMENT_INLINE_MIME_TYPES } from '@lazyit/shared';
import { attachmentsTmpDir } from './attachment-storage';

/**
 * Multer storage for the attachment uploads (ADR-0082 §3): **diskStorage streaming to
 * `attachments/tmp/`** — NEVER memoryStorage (the OOM red line; the tmp dir is on the same volume
 * as the blobs so promotion is one atomic rename). The on-disk name is a random UUID — the client
 * filename is NEVER a filesystem path (red line); it survives only as `originalName` metadata.
 * Kept out of attachment-storage.ts so the sandboxed re-encode child never pulls multer in.
 */
export function attachmentsUploadStorage(): StorageEngine {
  return diskStorage({
    destination: (_req, _file, cb) => {
      const dir = attachmentsTmpDir();
      try {
        mkdirSync(dir, { recursive: true });
        cb(null, dir);
      } catch (err) {
        cb(err as Error, dir);
      }
    },
    filename: (_req, _file, cb) => cb(null, `upload-${randomUUID()}`),
  });
}

/**
 * Build the `Content-Disposition` value for a served attachment (ADR-0082 §4): `inline` ONLY for
 * the raster image types the KB renders; everything else — PDFs included — is `attachment`
 * (download). The filename is sanitized (CR/LF/quotes/backslashes stripped, non-ASCII replaced) for
 * the plain parameter, with the real unicode name carried in RFC 5987 `filename*`.
 */
export function contentDispositionFor(
  mimeType: string,
  originalName: string,
): string {
  const kind = (ATTACHMENT_INLINE_MIME_TYPES as readonly string[]).includes(
    mimeType,
  )
    ? 'inline'
    : 'attachment';
  const fallback =
    originalName
      .replace(/[\r\n"\\;]/g, '_')
      .replace(/[^\x20-\x7e]/g, '_')
      .trim() || 'file';
  // RFC 5987: percent-encode, plus the characters encodeURIComponent leaves bare but 5987 reserves.
  const encoded = encodeURIComponent(originalName).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
