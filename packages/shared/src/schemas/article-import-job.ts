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
 * The body returned by `GET /articles/import/:jobId`.
 * - `articleId` is the created article's id — non-null **only** when `state === "completed"`.
 * - `error` is a SHORT, friendly message — non-null **only** when `state === "failed"`. A parse /
 *   decompression-bomb failure is PERMANENT: the message must never imply "try again later".
 */
export const ImportJobStatusSchema = z.object({
  jobId: z.string().min(1),
  state: ImportJobStateSchema,
  articleId: z.string().nullable(),
  error: z.string().nullable(),
});

export type ImportJobState = z.infer<typeof ImportJobStateSchema>;
export type ImportJobAccepted = z.infer<typeof ImportJobAcceptedSchema>;
export type ImportJobStatus = z.infer<typeof ImportJobStatusSchema>;
