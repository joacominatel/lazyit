/**
 * Wiring + payload constants for the Applications Workflow Engine run queue (ADR-0053 / ADR-0054 §8,
 * epic #248). The CORE (Phase 1b-B) consumes the shared BullMQ/Valkey connection provided GLOBALLY by
 * `QueueModule` (`BullModule.forRootAsync`, issue #257) — registering this queue inherits it; the
 * engine NEVER hand-rolls an ioredis client.
 */

/** The BullMQ queue name the engine's run jobs flow through (the `@InjectQueue` token base). */
export const WORKFLOW_RUN_QUEUE = 'workflow-run';

/** Job name: start a freshly-created run from its entry node (`steps[0]`). */
export const WORKFLOW_RUN_START_JOB = 'run-start';

/** Job name: resume a paused (AWAITING_INPUT) run after a manual task is resolved. */
export const WORKFLOW_RUN_RESUME_JOB = 'run-resume';

/**
 * Job name: re-enter a RUNNING run at a specific step to execute the NEXT retry attempt, after the
 * per-step backoff elapsed OFF the worker (CCOR-3). A delayed job carries `retryStepKey`/`retryAttempt`
 * so the orchestrator never holds a worker slot for the (up to 1h) backoff — the slot is freed and the
 * backoff is durable across restarts (the delayed job lives in Valkey).
 */
export const WORKFLOW_RUN_RETRY_JOB = 'run-retry';

/**
 * How long a run may sit `PENDING` before the sweeper considers its enqueue "missed" and re-enqueues
 * it ("Postgres remembers"). Generous enough that a healthy enqueue is never double-fired by the
 * sweeper (the start job races ahead and flips PENDING→RUNNING).
 */
export const PENDING_RUN_SWEEP_AFTER_MS = 30_000;

/**
 * How long a run may sit `AWAITING_INPUT` AFTER its latest ManualTask resolved before the sweeper's
 * AWAITING_INPUT reconciler re-derives + re-enqueues the lost resume (CCOR-2). Generous enough that a
 * healthy in-flight resume (the manual-tasks service's post-completion enqueue) is never raced; the
 * reconciler is the safety net for a resume LOST to a broker outage, a crash between complete() and
 * enqueue, or a transient DB error in resume()'s status flip.
 */
export const AWAITING_INPUT_SWEEP_AFTER_MS = 60_000;

/**
 * How long a run may sit `RUNNING` (with NO in-flight job) before the sweeper's RUNNING-staleness
 * reconciler finalizes it FAILED with an operator-visible `engine-restart` class (CCOR-4). A hard crash
 * mid-walk leaves a run RUNNING with no worker to finish it (the stalled re-delivery no-ops on the
 * PENDING guard); this threshold is comfortably longer than any single step execution + the in-process
 * degraded backoff, and a genuinely backing-off run is protected by the in-flight-job check (its delayed
 * retry job counts as in-flight).
 */
export const RUNNING_STALE_AFTER_MS = 300_000;

/**
 * The HARD cap on a DEGRADED in-process retry backoff — the fallback the orchestrator uses ONLY when
 * the broker is unavailable and the off-worker delayed re-enqueue (the normal CCOR-3 path) could not be
 * scheduled. Kept well under the BullMQ default `lockDuration` (30s) so even the worst case
 * (`maxAttempts` = 10 ⇒ ≤ 9 backoffs × this cap) stays inside the job lock; and the run is the
 * idempotency unit, so a stalled re-delivery during a degraded walk no-ops on the status guards.
 */
export const MAX_INPROCESS_BACKOFF_MS = 2_000;

/** How often the PENDING-run sweeper scans (a coarse safety net, not a hot loop). */
export const PENDING_RUN_SWEEP_INTERVAL_MS = 60_000;

/** Max steps a single walk will traverse before bailing — a defensive cap (the graph is acyclic). */
export const MAX_WALK_STEPS = 200;

/**
 * Build a BullMQ-safe custom jobId from its parts. BullMQ FORBIDS the colon (`:`) in a custom job id —
 * it is BullMQ's internal Redis key separator, so `queue.add` throws `Custom Id cannot contain :` and
 * the job never enqueues. We join the parts with `-` AND defensively replace any `:` a part itself
 * carries (a `cursor` / `stepKey` could contain one) with `-`. Pure + tiny; same parts ⇒ same id, so
 * the dedupe semantics are preserved. → see fix for #298 / ADR-0053.
 */
export function workflowJobId(...parts: Array<string | number>): string {
  return parts.map((part) => String(part).replace(/:/g, '-')).join('-');
}
