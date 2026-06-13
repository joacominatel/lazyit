import type { ArticleStatus, ZipImportResult } from '@lazyit/shared';

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
 * Which import path a job takes (ADR-0053 / ADR-0059 §5):
 * - `"single"` — one `.md`/`.txt`/`.docx` → exactly one Article (the original path).
 * - `"zip"` — a `.zip` archive → selective extraction + folder mirroring → MANY Articles.
 * Both ride the SAME sandboxed child and bomb-guard class; only the unpack-and-fan-out differs.
 * Absent on a legacy job ⇒ treated as `"single"` (back-compatible).
 */
export type ImportJobKind = 'single' | 'zip';

/**
 * The payload carried by an `article-import` job. The uploaded bytes ride along base64-encoded —
 * they are already capped at `MAX_IMPORT_SIZE_MB` synchronously at enqueue time; the DANGEROUS
 * decompression/expansion of a `.docx` (single) or a `.zip` archive happens later, inside the
 * sandboxed worker child (SEC-002). `authorId` is resolved from the request principal at enqueue
 * time (a human user, never a body value, never a service account — see ADR-0022/0048).
 *
 * For a `.zip` (`kind === "zip"`) `title`/`slug` do NOT apply (the archive holds many files, each
 * deriving its own title/slug from its filename); they are honoured only for a single-file import.
 * The `categoryId` is the ROOT home folder under which the mirrored zip tree is grafted.
 */
export interface ImportJobData {
  originalname: string;
  contentBase64: string;
  categoryId: string;
  status: ArticleStatus;
  title?: string;
  slug?: string;
  authorId: string;
  /** Import path; absent ⇒ `"single"` (back-compatible with already-queued legacy jobs). */
  kind?: ImportJobKind;
}

/**
 * A single-file job's return value; surfaced to the client as `articleId` once completed.
 * (`kind` lets {@link getStatus} tell a single result from a zip {@link ZipImportJobResult} without
 * re-reading the job data.)
 */
export interface SingleImportJobResult {
  kind?: 'single';
  articleId: string;
}

/**
 * A `.zip` job's return value (ADR-0059 §5): the per-item batch outcome surfaced to the client under
 * `ImportJobStatus.batch`. Reuses the shared {@link ZipImportResult} contract verbatim.
 */
export interface ZipImportJobResult {
  kind: 'zip';
  batch: ZipImportResult;
}

/** The job's return value — a single-file result OR a zip batch result. */
export type ImportJobResult = SingleImportJobResult | ZipImportJobResult;
