import { join } from 'node:path';

/**
 * Wiring constants for the migrator INGEST parse queue (ADR-0069 wave 2 / ADR-0053). Mirrors the
 * article-import harness (`articles/import/import-job.constants.ts`) — same sandboxed-child pattern,
 * its own queue.
 */

/** The BullMQ queue name. Injection token base for `@InjectQueue`. */
export const IMPORT_PARSE_QUEUE = 'import-parse';

/** The job name added to the queue (BullMQ groups jobs by name within a queue). */
export const IMPORT_PARSE_JOB_NAME = 'parse-import';

/** Default Node heap cap (MB) for the sandboxed parse child (see {@link parseChildHeapMb}). */
const DEFAULT_PARSE_HEAP_MB = 256;

/**
 * The heap cap (MB) passed to the forked parse child as `--max-old-space-size` (SEC-002). A
 * pathological CSV/JSON (e.g. a single field with gigabytes of quoted text, or a deeply nested JSON
 * blob) expands past any sane cap, so the child OOMs and dies while the API process stays alive.
 * Overridable via `IMPORT_CHILD_HEAP_MB` (shared with the article-import child — same isolation
 * boundary, same sizing invariant vs the api container `mem_limit`; see
 * articles/import/import-job.constants.ts and docs/05-runbooks/deploy-self-hosted.md §6). Falls back
 * to the default on a missing/invalid value.
 */
export function parseChildHeapMb(): number {
  const raw = process.env.IMPORT_CHILD_HEAP_MB;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_PARSE_HEAP_MB;
}

/**
 * Absolute path to the COMPILED sandboxed processor, resolved relative to this file at runtime
 * (`dist/import/import-parse.processor.js`). A BullMQ sandboxed processor is a forked Node child, so
 * it must point at the emitted `.js`, never the `.ts` source. `nest build` (tsc) preserves the
 * source tree under `dist/`, so this resolves in dev and prod alike.
 */
export function parseProcessorPath(): string {
  return join(__dirname, 'import-parse.processor.js');
}
