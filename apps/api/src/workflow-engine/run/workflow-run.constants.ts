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
 * How long a run may sit `PENDING` before the sweeper considers its enqueue "missed" and re-enqueues
 * it ("Postgres remembers"). Generous enough that a healthy enqueue is never double-fired by the
 * sweeper (the start job races ahead and flips PENDING→RUNNING).
 */
export const PENDING_RUN_SWEEP_AFTER_MS = 30_000;

/** How often the PENDING-run sweeper scans (a coarse safety net, not a hot loop). */
export const PENDING_RUN_SWEEP_INTERVAL_MS = 60_000;

/** Max steps a single walk will traverse before bailing — a defensive cap (the graph is acyclic). */
export const MAX_WALK_STEPS = 200;
