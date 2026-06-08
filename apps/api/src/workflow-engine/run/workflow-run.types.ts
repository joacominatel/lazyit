/**
 * Internal run-orchestration types (ADR-0054 §8). These are CORE-only shapes (job payloads, the
 * recorded transition, the resolved engine principal) — not wire DTOs. The redacted wire shapes the
 * controllers return are the shared `WorkflowRun` / `WorkflowStepRun` / `ManualTask` schemas plus the
 * run-detail composite assembled in `workflow-runs.service.ts`.
 */

/** The BullMQ job payload for the engine's `workflow-run` queue. Tiny on purpose — Postgres is truth. */
export interface WorkflowRunJobData {
  /** The WorkflowRun.id to advance. */
  runId: string;
  /**
   * Resume cursor: the step key (or terminal token) to continue the walk from, set only by a
   * resume job after a manual task is resolved. Absent ⇒ start from the entry node (`steps[0]`).
   */
  resumeCursor?: string;
}

/**
 * The outcome edge a step took, recorded into `WorkflowStepRun.metadata.transitionTaken` (NO
 * migration — the jsonb already exists, ADR-0054 §8). Mirrors the frontend C2 contract: `outcome`
 * (SUCCESS | FAILURE | PAUSE) + the closed `edge` vocabulary + the target step key when the edge
 * jumps/continues. The four-value failure set and three-value success set are the entire vocabulary
 * (no business-condition edges — the §8 guardrail at the contract boundary).
 */
export type TransitionOutcome = 'SUCCESS' | 'FAILURE' | 'PAUSE';
export type TransitionEdge =
  | 'NEXT'
  | 'GOTO'
  | 'END'
  | 'CONTINUE'
  | 'ESCALATE'
  | 'COMPENSATE'
  | 'STOP'
  | 'PAUSE';

export interface TransitionTaken {
  outcome: TransitionOutcome;
  edge: TransitionEdge;
  /** The step key the edge jumped/continued to (for GOTO/NEXT/CONTINUE/COMPENSATE-handler). */
  targetStepKey?: string;
}

/** The manual-task origin — DERIVED from the paused step's kind (no column; ADR-0054 §8 / C5). */
export type ManualTaskOrigin = 'MANUAL_STEP' | 'ESCALATED_FAILURE';
