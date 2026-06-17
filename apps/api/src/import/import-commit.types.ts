/**
 * Job-data + result contracts for the `import-commit` queue (ADR-0069 wave 4a, #633).
 *
 * PostgreSQL is the system of record (the `ImportRow` statuses + the `ImportRun` ledger row); the queue
 * is transport only, so the result is intentionally tiny — the worker writes per-row outcomes + the
 * ledger and the caller reads the truth from the DB by `sessionId`.
 */

/**
 * The commit job payload. The resolved ACTOR is captured at enqueue time (the operator who triggered
 * the commit) and carried into the worker, since a worker can't re-derive the request principal
 * (ADR-0069 §2). Phase-1 import is human-only (ADMIN), so the actor is a `User.id`.
 */
export interface CommitJobData {
  sessionId: string;
  /** The committing operator's `User.id` (human-only import — ADR-0069 §11). */
  actorUserId: string;
}

/** The worker's tiny result — the truth lives in the DB (`ImportRow` statuses + the `ImportRun` row). */
export interface CommitJobResult {
  sessionId: string;
  importRunId: number;
  committed: number;
  failed: number;
  skipped: number;
}
