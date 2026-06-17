import { z } from "zod";
import { ImportEntitySchema, ImportCountsSchema } from "./session";

/**
 * Migrator import — the HTTP wire shapes for the wizard endpoints (ADR-0069 wave 4b, #635).
 *
 * The session/dry-run/commit ENGINE contracts live beside them (session.ts, dry-run.ts,
 * resolution.ts); this file adds only the request/response envelopes the controller needs that
 * weren't already a contract: the async-accept handle (202), the polled session view, and the commit
 * result. Wire shapes only — owner-scoping, authz and the engine are server-side.
 */

/**
 * The 202 handle returned by `POST /imports` (upload) and `POST /imports/:id/commit` — the caller
 * polls the session/result endpoints by this `sessionId`. Mirrors the article-import async-accept
 * pattern (a tiny handle, the truth lives server-side).
 */
export const ImportSessionAcceptedSchema = z.object({
  sessionId: z.string(),
});
export type ImportSessionAccepted = z.infer<typeof ImportSessionAcceptedSchema>;

/** The detected source shape stamped on the session by the parse worker (PII-free: headers + counts). */
export const ImportDetectedShapeSchema = z.object({
  headers: z.array(z.string()),
  dialect: z.object({
    delimiter: z.string().nullable(),
    hadBom: z.boolean(),
  }),
  encoding: z.string(),
  rowCount: z.number().int().nonnegative(),
});
export type ImportDetectedShape = z.infer<typeof ImportDetectedShapeSchema>;

/** A single parsed source row in the session view (owner-scoped read). */
export const ImportSessionRowSchema = z.object({
  rowIndex: z.number().int().nonnegative(),
  status: z.string(),
  raw: z.record(z.string(), z.string()),
});

/**
 * The polled session view (`GET /imports/:id`): the session's status + the detected shape + its parsed
 * rows. Owner-scoped server-side; PII-free at the log layer (the rows themselves are the operator's own
 * uploaded data, returned only to the owner). `error` carries a PII-free phase+message when FAILED.
 */
export const ImportSessionViewSchema = z.object({
  id: z.string(),
  entity: ImportEntitySchema,
  status: z.string(),
  detected: ImportDetectedShapeSchema.nullable(),
  error: z
    .object({ phase: z.string(), message: z.string() })
    .nullable(),
  rowCount: z.number().int().nonnegative(),
  headers: z.array(z.string()),
  rows: z.array(ImportSessionRowSchema),
});
export type ImportSessionView = z.infer<typeof ImportSessionViewSchema>;

/**
 * The commit RESULT (`GET /imports/:id/result`) — the append-only `ImportRun` ledger view for a
 * COMMITTED session: who/what counts, plus the run id. Null while the commit hasn't produced a run yet
 * (the caller keeps polling the session view's status until COMMITTED).
 */
export const ImportCommitResultSchema = z.object({
  sessionId: z.string(),
  status: z.string(),
  importRunId: z.number().int().nonnegative().nullable(),
  counts: ImportCountsSchema.nullable(),
});
export type ImportCommitResult = z.infer<typeof ImportCommitResultSchema>;
