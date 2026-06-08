import { join } from 'node:path';

/**
 * Wiring constants for the async article-import queue (ADR-0053).
 */

/** The BullMQ queue name. Injection token base for `@InjectQueue`. */
export const ARTICLE_IMPORT_QUEUE = 'article-import';

/** The job name added to the queue (BullMQ groups jobs by name within a queue). */
export const ARTICLE_IMPORT_JOB_NAME = 'import-article';

/** Default Node heap cap (MB) for the sandboxed import child (see {@link importChildHeapMb}). */
const DEFAULT_IMPORT_HEAP_MB = 256;

/**
 * The heap cap (MB) passed to the forked import child as `--max-old-space-size`. A `.docx`
 * decompression bomb expands far beyond any sane cap, so the child OOMs and dies while the API
 * process stays alive (SEC-002). Overridable via `IMPORT_CHILD_HEAP_MB`; falls back to the default
 * on a missing/invalid value. Keep it generous enough for legitimately large documents.
 */
export function importChildHeapMb(): number {
  const raw = process.env.IMPORT_CHILD_HEAP_MB;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_IMPORT_HEAP_MB;
}

/**
 * Absolute path to the COMPILED sandboxed processor, resolved relative to this file at runtime
 * (`dist/articles/import/article-import.processor.js`). A BullMQ sandboxed processor is a forked
 * Node child, so it must point at the emitted `.js`, never the `.ts` source. `nest build` (tsc)
 * preserves the source tree under `dist/`, so this resolves in dev and prod alike.
 */
export function importProcessorPath(): string {
  return join(__dirname, 'article-import.processor.js');
}
