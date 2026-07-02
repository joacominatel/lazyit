import { join } from 'node:path';

/**
 * Wiring constants + env knobs for the attachments subsystem (ADR-0082).
 */

/** BullMQ queue for the sandboxed raster re-encode (EXIF strip / polyglot neutralization, §3). */
export const ATTACHMENT_REENCODE_QUEUE = 'attachment-reencode';
export const ATTACHMENT_REENCODE_JOB_NAME = 'reencode-image';

/** BullMQ queue for the daily GC sweep (ADR-0082 §6 — "a daily BullMQ sweep"). */
export const ATTACHMENTS_GC_QUEUE = 'attachments-gc';
export const ATTACHMENTS_GC_JOB_NAME = 'gc-sweep';
/** The stable job-scheduler id — upserted at boot, so re-deploys never stack duplicate schedules. */
export const ATTACHMENTS_GC_SCHEDULER_ID = 'attachments-gc-daily';
/** Daily (ADR-0082 §6 pin 4). */
export const ATTACHMENTS_GC_EVERY_MS = 24 * 60 * 60 * 1000;
/**
 * The GC grace window (ADR-0082 §6 pin 4): a never-referenced ARTICLE image (pasted into an
 * abandoned draft) is orphan-collected only once it is older than this — 24 h.
 */
export const ATTACHMENTS_GC_GRACE_MS = 24 * 60 * 60 * 1000;

/** Default total storage budget (MB) — ADR-0082 §7 proposes 5120 (5 GB). */
const DEFAULT_MAX_TOTAL_MB = 5120;

/**
 * The single-host storage quota (ADR-0082 §7): the total live-attachment byte budget, from
 * `ATTACHMENTS_MAX_TOTAL_MB` (default 5120 = 5 GB). Checked BEFORE an upload lands — over budget is
 * a clean "storage full" (507), never a 500 or a half-written blob. App-level on purpose: no
 * filesystem quotas/cgroups to configure (the `mem_limit`/log-rotation "one thing can't sink the
 * host" mold). Falls back to the default on a missing/invalid value.
 */
export function maxTotalAttachmentBytes(): number {
  const raw = process.env.ATTACHMENTS_MAX_TOTAL_MB;
  const parsed = raw === undefined ? NaN : Number(raw);
  const mb =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TOTAL_MB;
  return Math.floor(mb * 1024 * 1024);
}

/**
 * Root of the blob store (ADR-0082 §2): `<dir>/<sha[0:2]>/<sha256>` blobs + `<dir>/tmp/` in-flight
 * uploads (same volume → finalize is one atomic rename). `ATTACHMENTS_DIR` overrides; the default
 * resolves against the process cwd — `/app/attachments` in the container (WORKDIR /app, where the
 * `attachments_data` volume mounts) and `apps/api/attachments` in native dev (gitignored).
 */
export function attachmentsDir(): string {
  const raw = process.env.ATTACHMENTS_DIR;
  return raw && raw.trim() !== '' ? raw : join(process.cwd(), 'attachments');
}

/** Default Node heap cap (MB) for the sandboxed re-encode child (see {@link reencodeChildHeapMb}). */
const DEFAULT_REENCODE_HEAP_MB = 256;

/**
 * Heap cap (MB) passed to the forked re-encode child as `--max-old-space-size` — the same SEC-002
 * isolation as the import child (import-job.constants.ts, incl. its OPS-5 `mem_limit` sizing
 * invariant): a hostile/pathological image kills the CHILD, never the API. sharp's pixel work is
 * additionally bounded by its own `limitInputPixels` default. Overridable via
 * `ATTACHMENT_CHILD_HEAP_MB`; falls back on a missing/invalid value.
 */
export function reencodeChildHeapMb(): number {
  const raw = process.env.ATTACHMENT_CHILD_HEAP_MB;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_REENCODE_HEAP_MB;
}

/**
 * Absolute path to the COMPILED sandboxed re-encode processor (the emitted `.js`, never the `.ts`
 * source — a BullMQ sandboxed processor is a forked Node child). Mirrors `importProcessorPath`.
 */
export function reencodeProcessorPath(): string {
  return join(__dirname, 'image-reencode.processor.js');
}
