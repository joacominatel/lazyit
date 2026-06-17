import type { ImportFormat } from './parser';

/**
 * The job-data + result contracts for the `import-parse` queue (ADR-0069 wave 2). PostgreSQL is the
 * system of record (the `ImportSession`/`ImportRow` rows); the queue is only transport, so the result
 * is intentionally tiny — the worker writes the rows + advances the session status itself, and the
 * caller reads the outcome from the DB by `sessionId`.
 */

/** Minimal uploaded-file shape the service accepts (a subset of `Express.Multer.File`). */
export interface UploadedImportFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

/**
 * The parse job payload. The raw file bytes ride along base64-encoded (already ≤ the multer size cap,
 * SEC-001) — ADR-0069 §2: the file is parsed ONCE in the child and discarded, never written to a blob
 * store (no PII at rest beyond the parsed `ImportRow`s under their 24h TTL).
 *
 * ponytail: raw-file transport = base64-in-Redis (same as the article harness). Ceiling: the job
 * payload is bounded by the 5 MB import cap, so it stays well under Redis's practical value size; the
 * file lives only for the life of the job. Upgrade path: if the import cap is ever raised past tens
 * of MB, move the bytes to a short-lived object store / tmpfile keyed by sessionId and pass only the
 * key here (the worker already owns its own IO, so only the read site changes).
 */
export interface ParseJobData {
  sessionId: string;
  format: ImportFormat;
  contentBase64: string;
}

/** The worker's tiny result — the truth lives in the DB; this is just for logging/polling. */
export interface ParseJobResult {
  sessionId: string;
  /** `'parsed'` on success, `'failed'` when the input was malformed. */
  outcome: 'parsed' | 'failed';
  rowCount: number;
}
