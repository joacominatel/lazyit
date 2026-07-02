import { z } from "zod";

/**
 * Update awareness & guided update — wire contracts (ADR-0084, issue #904). Extends the ADR-0083
 * version identity (`GET /instance/version`) with the CONSUMPTION half: "is a newer release out, how
 * far behind am I, and let me enqueue a guided host update". The single source of truth for `api`
 * (endpoint typing + the update-check cache) and `web` (the Settings → Instance "Version & updates"
 * card). See docs/03-decisions/0084-update-awareness-and-guided-update.md.
 *
 * The model in one paragraph: an opt-in, beacon-free, fail-soft weekly check caches the latest known
 * GitHub release in a singleton config row; an ADMIN "update" action ENQUEUES an append-only
 * {@link UpdateRun} row and is shown the exact `./infra/update.sh vX.Y.Z` command to run on the host —
 * the API NEVER executes anything (no docker socket, no auto-apply; the host script mutates the host
 * and stamps its progress back into the same row over plain Postgres). These types carry NO secret or
 * host-identifying material.
 */

// ── UpdateRun status (the closed catalog) ────────────────────────────────────

/**
 * The lifecycle of one guided update (ADR-0084 §4). String-valued (not a Prisma enum) so the HOST
 * script can advance it with a plain SQL `UPDATE` without knowing a DB enum type, and so adding a
 * phase later is a shared-package change, never a migration — the same catalog-as-code instinct as
 * `NotificationType`. Terminal states: `done`, `failed`, `rolled_back`.
 *   - requested   — the API enqueued the intent; the operator has not yet run the host script.
 *   - backing_up  — the host script is taking the mandatory verified pre-update dump of BOTH DBs.
 *   - migrating   — the Prisma migrate one-shot is running (forward-only).
 *   - building    — building the new images from the checked-out tag (before swapping the stack).
 *   - restarting  — recreating the stack on the new version (the ~60s blip; the API restarts here).
 *   - verifying   — polling `/health/ready` and confirming `GET /instance/version == target`.
 *   - done        — the new version is up and verified.
 *   - failed      — the update stopped; see `error`. When a migration had run, a guided (confirm-gated)
 *                   restore of the pre-update dump is the recovery — NEVER an automatic DB restore.
 *   - rolled_back — the update failed BEFORE any migration ran and the host auto-reverted to the
 *                   previous tag (fast + lossless; no data was lost).
 */
export const UPDATE_RUN_STATUSES = [
  "requested",
  "backing_up",
  "migrating",
  "building",
  "restarting",
  "verifying",
  "done",
  "failed",
  "rolled_back",
] as const;
export const UpdateRunStatusSchema = z.enum(UPDATE_RUN_STATUSES);
export type UpdateRunStatus = z.infer<typeof UpdateRunStatusSchema>;

/** The non-terminal (still-in-flight) statuses — the boot-reconciliation + "active run" set. */
export const UPDATE_RUN_ACTIVE_STATUSES = [
  "requested",
  "backing_up",
  "migrating",
  "building",
  "restarting",
  "verifying",
] as const satisfies readonly UpdateRunStatus[];

/** True when a run is still in flight (not `done` / `failed` / `rolled_back`). */
export function isActiveUpdateRun(status: UpdateRunStatus): boolean {
  return (UPDATE_RUN_ACTIVE_STATUSES as readonly UpdateRunStatus[]).includes(status);
}

// ── UpdateRun (one guided update, append-only ledger row) ────────────────────

/**
 * One guided update as the Settings → Instance card renders it (ADR-0084 §4). An append-only ledger
 * row (autoincrement id, never deleted) whose `status` transitions during execution — the same shape
 * as a WorkflowRun. `requestedByUserId` is the human who enqueued it (null once that user is deleted).
 * `logTail` is a short, REDACTED tail of host-script output (operational lines only — never secrets or
 * env values). All timestamps are ISO-8601 strings (wire shape).
 */
export const UpdateRunSchema = z.object({
  id: z.number().int().positive(),
  requestedByUserId: z.uuid().nullable(),
  /** The version running when the update was requested (`APP_VERSION` at enqueue); may be "dev". */
  fromVersion: z.string(),
  /** The target release tag the operator is moving to (e.g. "v1.5.0"). */
  toVersion: z.string(),
  status: UpdateRunStatusSchema,
  /** When the host script picked the run up (first transition past `requested`); null while pending. */
  startedAt: z.iso.datetime().nullable(),
  /** When the run reached a terminal state; null while in flight. */
  finishedAt: z.iso.datetime().nullable(),
  /** A short, redacted tail of host output for the in-progress / failed view; null when none. */
  logTail: z.string().nullable(),
  /** A short, non-secret failure reason; null unless `status === "failed"`. */
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type UpdateRun = z.infer<typeof UpdateRunSchema>;

// ── Enqueue an update (POST /instance/update) ────────────────────────────────

/**
 * The body of `POST /instance/update` — ADMIN (`settings:manage`), human-only. It ENQUEUES a run for
 * the requested target tag and returns the created {@link UpdateRun}; it executes NOTHING. `toVersion`
 * must be a `vX.Y.Z`-shaped tag; the API further rejects a target that is not strictly newer than the
 * running version (there is nothing to update to).
 */
export const EnqueueUpdateSchema = z.object({
  toVersion: z
    .string()
    .trim()
    .min(1)
    .regex(/^v?\d+\.\d+\.\d+$/, "must be a version tag like v1.5.0"),
});
export type EnqueueUpdate = z.infer<typeof EnqueueUpdateSchema>;

// ── Update-check settings (the opt-in toggle) ────────────────────────────────

/**
 * The admin-facing update-check settings (`GET`/`PUT /instance/update-settings`). One field in v1:
 * the opt-in toggle, DEFAULT OFF (ADR-0084 §1) — beacon-free, egress-never-mandatory. The cached
 * check RESULT is exposed via {@link UpdateStatus}, not here (this is the writable knob only).
 */
export const UpdateSettingsSchema = z.object({
  /** Weekly anonymous GitHub-releases check. Default OFF; when off the card degrades to version-only. */
  checkEnabled: z.boolean(),
});
export type UpdateSettings = z.infer<typeof UpdateSettingsSchema>;

// ── Update status (GET /instance/update-status — the card's read) ────────────

/**
 * Everything the "Version & updates" card needs in ONE read (ADR-0084 §5): the running version, the
 * opt-in state, the cached latest-known release + how far behind, when it was last checked, and the
 * most-recent runs. The client NEVER fetches GitHub — it reads this cache. `latestVersion === null`
 * means "not checked yet / couldn't check" (which is NEVER "up to date" — the UI distinguishes them
 * via `checkEnabled` + `checkedAt`).
 */
export const UpdateStatusSchema = z.object({
  /** The running build (mirrors `GET /instance/version.current`), for a self-contained card read. */
  currentVersion: z.string(),
  /** Whether the weekly check is opted in. When false the card shows version only. */
  checkEnabled: z.boolean(),
  /** The latest known release tag from the last successful check; null when unknown / checks off. */
  latestVersion: z.string().nullable(),
  /** The latest release's GitHub page; null when unknown. */
  htmlUrl: z.string().nullable(),
  /** How many releases newer than the running version (0 when current / unknown). */
  behindBy: z.number().int().min(0),
  /** When the last successful check ran (ISO-8601); null when never checked. */
  checkedAt: z.iso.datetime().nullable(),
  /** The current in-flight run (if any) — drives the stage labels + reconnecting state. */
  activeRun: UpdateRunSchema.nullable(),
  /** The most-recent runs (newest-first, capped) for the history list. */
  recentRuns: z.array(UpdateRunSchema),
});
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;
