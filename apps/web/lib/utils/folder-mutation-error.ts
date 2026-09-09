import { ApiError } from "@/lib/api/client";

/**
 * The folder write endpoints (`POST /article-categories`, `PATCH /article-categories/:id`) reject
 * three specific situations, and each one deserves its own sentence in the UI rather than the
 * server's raw English message or a generic "couldn't save" toast (#1291):
 *
 *   - `cycle`         — 400, the move would make the folder its own ancestor (the DFS guard,
 *                       ADR-0059 §1), or the folder was pointed at itself.
 *   - `deadParent`    — 400, `parentId` does not reference a live folder (it was soft-deleted
 *                       under a stale tree in another tab).
 *   - `duplicateName` — 409, the per-parent partial-unique name index rejected the name.
 *
 * The guards themselves are NEVER reimplemented here: the server is the sole authority and this
 * only classifies what it answered, so a future backend rule keeps working (it just falls back to
 * the server's own message via `null`).
 *
 * Why 409 alone is enough for `duplicateName`: on these two endpoints the service raises no
 * `ConflictException` of its own (the only ones live in the delete path), so the sole source of a
 * 409 is the `PrismaExceptionFilter` mapping P2002 — the `(parentId, name) WHERE "deletedAt" IS
 * NULL` index. Status matching also survives the filter's message wording changing.
 */
export type FolderMutationErrorKind = "cycle" | "deadParent" | "duplicateName";

/** Matches both 400 cycle messages: the self-parent short-circuit and the DFS walk's rejection. */
const CYCLE_PATTERN = /cycle|its own parent/i;
/** Matches `parentId <id> does not reference a live folder`. */
const DEAD_PARENT_PATTERN = /does not reference a live folder/i;

/**
 * Classify a failed folder create/update into one of the {@link FolderMutationErrorKind}s, or
 * `null` when the failure is anything else (a 401, a 500, a network error) — the caller then falls
 * back to `notifyError`, which surfaces the server's message and the request id.
 */
export function folderMutationErrorKind(
  error: unknown,
): FolderMutationErrorKind | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 409) return "duplicateName";
  if (error.status !== 400) return null;
  if (CYCLE_PATTERN.test(error.message)) return "cycle";
  if (DEAD_PARENT_PATTERN.test(error.message)) return "deadParent";
  return null;
}
