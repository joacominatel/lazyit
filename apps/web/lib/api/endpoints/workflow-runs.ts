import type {
  ManualInputField,
  Page,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStepRunStatus,
  WorkflowTrigger,
  WorkflowTriggerV1,
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

/**
 * C4 — DRY-RUN contracts (`POST /workflow-runs/dry-run`, frontend.md §8). A dry-run is a PURE
 * payload-resolution preview: the engine walks the pinned version's DAG, resolves each step's data
 * mapping against a real sample grant, and returns the would-be requests + the traversal in the SAME
 * step-shaped data the run timeline renders — making NO real external call and writing NO ledger rows.
 * Gated `workflow:manage`. The backend models the request/result as api-internal shapes (no shared
 * schema), so the wire types are declared here as FE view types. Every value the result carries is
 * already redacted (INV-6): a secret-backed header is a `‹secret:label›` placeholder, never the
 * credential — the UI renders ALL of it as escaped text and NEVER un-redacts (SEC-A5).
 */

/** Request body: identify the workflow by `workflowId` OR by `applicationId` + `trigger`. */
export interface WorkflowDryRunInput {
  /** Either pass the workflow id directly… */
  workflowId?: string;
  /** …or resolve the live binding for this app + event (both required together). */
  applicationId?: string;
  trigger?: WorkflowTriggerV1;
  /** A real grant to resolve the mapping context against (its grantee/app/grant fields). */
  sampleAccessGrantId: string;
  /** Force ONE step's outcome to FAILURE to preview its failure edge (escalate/compensate/stop). */
  simulate?: { stepKey: string; outcome: "FAILURE" };
}

/** The status this preview assumed for a step (the run-timeline subset a dry-run step can show). */
export type DryRunStepStatus = "SUCCEEDED" | "FAILED" | "AWAITING_INPUT";

/** The terminal the traversal ended on (the four ADR-0054 transition terminals). */
export type DryRunEndState =
  | "END_SUCCESS"
  | "STOP_FAIL"
  | "ESCALATE_TO_MANUAL"
  | "COMPENSATE";

/**
 * The REDACTED would-be outbound request for a REST / WEBHOOK_OUT step. The body is resolved purely
 * from the mapping context (which never carries a secret); any credential header is a `‹secret:label›`
 * placeholder — NEVER the real value.
 */
export interface DryRunRequestPreview {
  kind: "REST" | "WEBHOOK_OUT";
  method: string;
  /** Fixed host (connection baseUrl/url) + the rendered relative path. */
  url: string;
  /** Resolved headers; any credential value is a `‹secret:label›` placeholder. */
  headers: Record<string, string>;
  /** Resolved JSON body leaves (the data mapping), for the body-carrying verbs. */
  body?: Record<string, string>;
  /** Whether the payload WOULD be HMAC-signed (WEBHOOK_OUT). */
  signed?: boolean;
}

/**
 * The frozen, allowlisted mapping context the payloads resolved against — secret-free by construction.
 * All string fields are UNTRUSTED (grantee display name, free-form access level) and must be rendered
 * as escaped text only (SEC-A5).
 */
export interface DryRunMappingContext {
  event: WorkflowTrigger;
  grantee: { id: string; email: string; firstName: string; lastName: string };
  application: { id: string; name: string };
  grant: {
    id: string;
    accessLevel: string | null;
    grantedAt: string;
    expiresAt: string | null;
  };
  /** Outputs of earlier steps in this run, keyed by step key (empty for the first step). */
  steps: Record<string, Record<string, unknown>>;
}

/**
 * One step in the dry-run traversal — the SAME shape the run-timeline renders (stepKey/kind/status/
 * transitionTaken/mappedFields) plus the dry-run preview (`request` / `manual`) and any `warnings`.
 */
export interface DryRunStep {
  stepIndex: number;
  stepKey: string;
  kind: "REST" | "WEBHOOK_OUT" | "MANUAL";
  name: string | null;
  status: DryRunStepStatus;
  /** True when this step's outcome was FORCED by the request's `simulate`. */
  simulated: boolean;
  /** The edge that WOULD be taken — the exact `transitionTaken` shape the timeline draws. */
  transitionTaken: WorkflowTransitionTaken | null;
  /** The NAMES of the mapped fields (never their values — values live in `request.body`). */
  mappedFields: string[];
  /** The would-be request for a REST/WEBHOOK_OUT step; null for MANUAL. */
  request: DryRunRequestPreview | null;
  /** The rendered prompt + input form for a MANUAL step; null otherwise. */
  manual: { prompt: string; inputFields: ManualInputField[] } | null;
  /** Non-secret advisories (e.g. a missing credential / connection) the live run would hit. */
  warnings: string[];
}

/**
 * The dry-run result — a pure resolver output (NO rows written, NO external call). Carries the resolved
 * mapping `context`, the ordered `steps` traversal, the terminal `endState`, and `wouldPause` (true
 * when a MANUAL step pauses on the happy path). `requestId` correlates the resolve (ADR-0031).
 */
export interface DryRunResult {
  dryRun: true;
  workflowId: string;
  /** The pinned WorkflowVersion row id the walk used (the latest version). */
  workflowVersionId: number;
  /** The monotonic version NUMBER (for display). */
  version: number;
  applicationId: string;
  trigger: WorkflowTrigger;
  sampleAccessGrantId: string;
  context: DryRunMappingContext;
  /** Echo of the forced-outcome request, if any. */
  simulate: { stepKey: string; outcome: "FAILURE" } | null;
  steps: DryRunStep[];
  endState: DryRunEndState;
  /** True when the happy-path traversal crosses a MANUAL step (the real run would pause). */
  wouldPause: boolean;
  requestId: string;
}

/**
 * Dry-run a workflow against a sample grant (`POST /workflow-runs/dry-run`). Provide `workflowId`, OR
 * `applicationId` + `trigger`. Pure preview — no external call, no ledger rows. 400 if the version is
 * empty / the sample grant is cross-app / `simulate.stepKey` is unknown; 404 if no workflow resolves.
 */
export function dryRunWorkflow(
  body: WorkflowDryRunInput,
): Promise<DryRunResult> {
  return apiFetch<DryRunResult>(`${BASE}/dry-run`, {
    method: "POST",
    body,
  });
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
