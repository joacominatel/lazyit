import type { ArticleStatus } from '@lazyit/shared';

/**
 * Shapes for the async article-import job (ADR-0053). The job travels through the BullMQ queue as
 * JSON serialized into Redis, so {@link ImportJobData} is plain JSON (the file bytes are base64).
 */

/** The subset of a multer file the import needs. The controller passes Express.Multer.File. */
export interface UploadedImportFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

/**
 * The payload carried by an `article-import` job. The uploaded bytes ride along base64-encoded —
 * they are already capped at `MAX_IMPORT_SIZE_MB` synchronously at enqueue time; the DANGEROUS
 * decompression/expansion of a `.docx` happens later, inside the sandboxed worker child (SEC-002).
 * `authorId` is resolved from the request principal at enqueue time (a human user, never a body
 * value, never a service account — see ADR-0022/0048).
 */
export interface ImportJobData {
  originalname: string;
  contentBase64: string;
  categoryId: string;
  status: ArticleStatus;
  title?: string;
  slug?: string;
  authorId: string;
}

/** The job's return value; surfaced to the client as `articleId` once the job completes. */
export interface ImportJobResult {
  articleId: string;
}
