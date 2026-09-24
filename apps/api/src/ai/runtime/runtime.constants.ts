/**
 * Runtime limits and timings (provider-and-runtime.md §6.4, §8, §9.1, §11; security.md §6.8). The queue
 * and job names and the tool-result cap live in `../ai.constants.ts`; these are the runtime's own.
 */

/** `ai-run` worker concurrency when `AI_WORKER_CONCURRENCY` is unset or invalid (§9.1). */
export const AI_WORKER_CONCURRENCY_DEFAULT = 4;
/** Upper bound on `AI_WORKER_CONCURRENCY` (each run holds a provider stream; the api has 768 MiB). */
export const AI_WORKER_CONCURRENCY_MAX = 16;

/** `AI_WORKER_CONCURRENCY` from the environment, bounded; the default when unset or not an integer. */
export function aiWorkerConcurrency(
  raw: string | undefined = process.env.AI_WORKER_CONCURRENCY,
): number {
  const value = raw === undefined ? NaN : Number(raw.trim());
  if (!Number.isInteger(value) || value < 1) {
    return AI_WORKER_CONCURRENCY_DEFAULT;
  }
  return Math.min(value, AI_WORKER_CONCURRENCY_MAX);
}

/** At most this many runs per principal in QUEUED, RUNNING or AWAITING_APPROVAL (§9.1). */
export const AI_MAX_ACTIVE_RUNS_PER_PRINCIPAL = 3;
/** Run creations per principal: a token bucket of this capacity, refilled over a minute (§9.1). */
export const AI_RUN_CREATIONS_PER_MINUTE = 30;
/** Tool calls per principal: a token bucket of this capacity, refilled over a minute (tools §8.4). */
export const AI_TOOL_CALLS_PER_MINUTE = 60;
/** Tool calls one run may make across all its steps (security.md §6.8: "at most 30 tool calls"). */
export const AI_MAX_TOOL_CALLS_PER_RUN = 30;
/** Pending chat writes one step may propose; the rest are refused (security.md §6.8, fatigue). */
export const AI_MAX_PENDING_PER_STEP = 5;

/** The rolling window of the per-principal token budget (§11). */
export const AI_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Backstop on the serialized tool output handed to the model. Core already truncates a result's data at
 * `AI_TOOL_RESULT_MAX_CHARS`; this bounds everything else (error text, summaries, refs) once, at write time.
 */
export const AI_TOOL_OUTPUT_MAX_CHARS = 24_000;

/** How often the sweeper runs (a coarse safety net, not a hot loop). */
export const AI_RUN_SWEEP_INTERVAL_MS = 30_000;
/** A QUEUED run whose job is not on the queue after this long had its enqueue lost. */
export const AI_QUEUED_SWEEP_AFTER_MS = 30_000;
/** An AWAITING_APPROVAL run whose calls are all decided but not resumed after this long lost its resume. */
export const AI_AWAITING_SWEEP_AFTER_MS = 60_000;
/** A RUNNING run with no in-flight job after this long is finalized FAILED (`ENGINE_RESTART`). */
export const AI_RUNNING_STALE_AFTER_MS = 300_000;
/** A tool invocation still EXECUTING after this long was interrupted: OUTCOME_UNKNOWN, never retried. */
export const AI_EXECUTING_STALE_AFTER_MS = 300_000;
/** At most this many rows per reconciler per pass. */
export const AI_SWEEP_BATCH = 100;

/** Step-up backoff (the `LoginService` policy, ADR-0086 §3): no delay for the first N failures. */
export const AI_STEP_UP_FAILURE_THRESHOLD = 5;
export const AI_STEP_UP_BASE_DELAY_MS = 1_000;
export const AI_STEP_UP_MAX_DELAY_MS = 15 * 60 * 1000;
/** A cooled-down step-up record is forgotten after this long. */
export const AI_STEP_UP_RESET_AFTER_MS = 60 * 60 * 1000;

/**
 * A BullMQ-safe job id: BullMQ forbids `:` in a custom id, so parts are joined with `-` and any `:` a part
 * carries is replaced (the `workflowJobId` precedent, ADR-0053).
 */
export function aiRunJobId(...parts: Array<string | number>): string {
  return parts.map((part) => String(part).replace(/:/g, '-')).join('-');
}
