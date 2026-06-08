import type {
  Page,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStepRunStatus,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data-access for `WorkflowRun` — the execution ledger / audit trail (ADR-0054 §4). Runs are
 * engine-written (no client create). All bodies are pre-redacted server-side (INV-6, ADR-0031); the FE
 * renders only what the API returns and NEVER un-redacts.
 *
 * Backend contract (Phase 1b-B): `GET /workflow-runs?applicationId=&workflowId=&accessGrantId=&status=`
 * → `Page<WorkflowRun>`; `GET /workflow-runs/:id` → the run PLUS its ordered step attempts, each
 * carrying the DAG fields (`transitionTaken`, escalation/compensation linkage). The enriched
 * step-detail shape and the run-with-steps composite are richer than the shared `WorkflowStepRun`
 * primitive, so they are declared here as FE view types over the shared enums.
 */

const BASE = "/workflow-runs";

/** The outcome side of a step's taken transition (PAUSE = an AWAITING_INPUT pause). */
export type WorkflowTransitionOutcome = "SUCCESS" | "FAILURE" | "PAUSE";

/** The concrete edge a step took (the closed, opinionated set — no business-condition edges). */
export type WorkflowTransitionEdge =
  | "NEXT"
  | "GOTO"
  | "END"
  | "CONTINUE"
  | "ESCALATE"
  | "COMPENSATE"
  | "STOP"
  | "PAUSE";

/** Which edge a step run took, and (for GOTO/COMPENSATE) the step key it routed to. */
export interface WorkflowTransitionTaken {
  outcome: WorkflowTransitionOutcome;
  edge: WorkflowTransitionEdge;
  targetStepKey?: string;
}

/**
 * One step ATTEMPT in a run's traversed graph (`GET /workflow-runs/:id` → `steps[]`), ordered by
 * attempt. Richer than the shared `WorkflowStepRun`: it adds the resolved `durationMs`/`statusCode`/
 * `errorClass`, the `transitionTaken` edge, and the escalation/compensation linkage the run timeline
 * draws. Nullable fields are absent until/unless the engine records them.
 */
export interface WorkflowRunStep {
  id: number;
  stepIndex: number;
  stepKey: string;
  attempt: number;
  status: WorkflowStepRunStatus;
  externalCorrelationId: string | null;
  durationMs: number | null;
  statusCode: number | null;
  errorClass: string | null;
  transitionTaken: WorkflowTransitionTaken | null;
  /** The ManualTask an ESCALATE edge opened (link to the inbox), if any. */
  manualTaskId: string | null;
  /** The step a COMPENSATE edge ran, if any. */
  compensationStepKey: string | null;
  /** Redacted outcome metadata only (never bodies/secrets/PII). */
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/** A run plus its ordered, traversed step attempts. */
export interface WorkflowRunDetail extends WorkflowRun {
  steps: WorkflowRunStep[];
}

export interface WorkflowRunFilters {
  applicationId?: string;
  workflowId?: string;
  accessGrantId?: string;
  status?: WorkflowRunStatus;
  /** Page size (ADR-0030; 1-200). */
  limit?: number;
  /** Zero-based window offset (ADR-0030). */
  offset?: number;
}

/** List runs (filtered, paged). Returns the `Page<WorkflowRun>` envelope (ADR-0030). */
export function getWorkflowRuns(
  filters: WorkflowRunFilters = {},
): Promise<Page<WorkflowRun>> {
  const params = new URLSearchParams();
  if (filters.applicationId) params.set("applicationId", filters.applicationId);
  if (filters.workflowId) params.set("workflowId", filters.workflowId);
  if (filters.accessGrantId)
    params.set("accessGrantId", filters.accessGrantId);
  if (filters.status) params.set("status", filters.status);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters.offset !== undefined)
    params.set("offset", String(filters.offset));
  const qs = params.toString();
  return apiFetch<Page<WorkflowRun>>(qs ? `${BASE}?${qs}` : BASE);
}

/** Fetch one run with its ordered step attempts and the traversed graph (`GET /workflow-runs/:id`). */
export function getWorkflowRun(id: string): Promise<WorkflowRunDetail> {
  return apiFetch<WorkflowRunDetail>(`${BASE}/${id}`);
}

/** The run statuses that are TERMINAL — polling stops once a run reaches one of these. */
const TERMINAL_RUN_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set([
  "SUCCEEDED",
  "FAILED",
  "COMPENSATED",
]);

/**
 * Whether a run status is terminal (no further status changes expected). The run-detail/list hooks
 * poll with `refetchInterval` ONLY while a run is non-terminal, so there is never idle polling.
 */
export function isTerminalRunStatus(status: WorkflowRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}
