import { z } from "zod";

/**
 * Async article import job (ADR-0053). `POST /articles/import` validates the upload synchronously,
 * enqueues a BullMQ job and returns 202 with a `jobId`; the web client then polls
 * `GET /articles/import/:jobId` for the outcome. The heavy/dangerous `.docx` parse runs in a
 * sandboxed (forked, heap-capped) worker so a decompression bomb crashes the child, not the API
 * (SEC-002). Single source of truth for api and web.
 */

/**
 * The lifecycle of an import job as the web client observes it. The BullMQ-internal states
 * (`waiting`, `delayed`, `prioritized`, `waiting-children`, …) all collapse to `queued`; only the
 * four below are surfaced.
 */
export const ImportJobStateSchema = z.enum([
  "queued",
  "active",
  "completed",
  "failed",
]);

/** The body returned by `POST /articles/import` (HTTP 202). The handle the client polls with. */
export const ImportJobAcceptedSchema = z.object({
  jobId: z.string().min(1),
});

/**
 * The outcome of a single entry inside a bulk `.zip` import (ADR-0059 §5). A `.zip` mints many
 * articles in one sandboxed job; each surfaced entry resolves to exactly one of:
 * - `"created"` — an Article was created from a `.md`/`.txt` entry under `slug`.
 * - `"renamed"` — created, but its derived slug collided so it was auto-suffixed (`nextAvailableSlug`,
 *   §3); `slug` is the FINAL slug, `requestedSlug` the one originally derived. Nothing is swallowed.
 * - `"skipped"` — the entry was ignored (an image, a binary, a nested `.docx` in v1, a dotfile, an
 *   empty/no-text file, …); `reason` is a short, human label. A skip is NEVER an error.
 * `path` is the entry's path inside the archive (the audit key). `articleId`/`slug` are non-null only
 * for created/renamed items; `requestedSlug` only for a rename; `reason` only for a skip.
 */
export const ZipItemOutcomeSchema = z.enum(["created", "renamed", "skipped"]);

export const ZipItemResultSchema = z.object({
  path: z.string(),
  outcome: ZipItemOutcomeSchema,
  articleId: z.string().nullable().default(null),
  slug: z.string().nullable().default(null),
  requestedSlug: z.string().nullable().default(null),
  reason: z.string().nullable().default(null),
});

/**
 * The per-item batch outcome of a completed `.zip` import (ADR-0059 §5) — the audit of a fan-out:
 * how many folders were created, every item's outcome (created / renamed / skipped + reason), and
 * how many `[[link]]` edges the best-effort rewire resolved. Surfaced under `ImportJobStatus.batch`
 * only for a `.zip` job; a single-file import leaves it null.
 */
export const ZipImportResultSchema = z.object({
  foldersCreated: z.number().int().nonnegative(),
  items: z.array(ZipItemResultSchema),
  /** Tallies for an at-a-glance summary (derivable from `items`, precomputed for the client). */
  createdCount: z.number().int().nonnegative(),
  renamedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  /** Wiki-link edges (`ArticleWikiLink`) that resolved after the best-effort intra-batch rewire (§5). */
  linksResolved: z.number().int().nonnegative(),
});

/**
 * The body returned by `GET /articles/import/:jobId`.
 * - `articleId` is the created article's id — non-null **only** when `state === "completed"` for a
 *   SINGLE-file import (`.md`/`.txt`/`.docx`). A `.zip` import leaves it null (it has no single id).
 * - `batch` is the per-item `.zip` outcome — non-null **only** when `state === "completed"` for a
 *   `.zip` import. A single-file import leaves it null. (ADDITIVE in ADR-0059 §5: a single-file
 *   client that ignores `batch` is unaffected.)
 * - `error` is a SHORT, friendly message — non-null **only** when `state === "failed"`. A parse /
 *   decompression-bomb / over-quota failure is PERMANENT: the message must never imply "try again
 *   later".
 */
export const ImportJobStatusSchema = z.object({
  jobId: z.string().min(1),
  state: ImportJobStateSchema,
  articleId: z.string().nullable(),
  batch: ZipImportResultSchema.nullable().default(null),
  error: z.string().nullable(),
});

export type ImportJobState = z.infer<typeof ImportJobStateSchema>;
export type ImportJobAccepted = z.infer<typeof ImportJobAcceptedSchema>;
export type ImportJobStatus = z.infer<typeof ImportJobStatusSchema>;
export type ZipItemOutcome = z.infer<typeof ZipItemOutcomeSchema>;
export type ZipItemResult = z.infer<typeof ZipItemResultSchema>;
export type ZipImportResult = z.infer<typeof ZipImportResultSchema>;
