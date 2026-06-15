import type {
  ManualInputField,
  Page,
  ReplayLatestResponse,
  RetryRunOverrides,
  RetryRunResponse,
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
 * `errorClass`, the request SHAPE (`method`/`targetHost`/`mappedFields`), the `transitionTaken` edge,
 * and the escalation/compensation linkage the run timeline draws. Nullable fields are absent
 * until/unless the engine records them.
 *
 * Every field here is the engine's REDACTED projection (INV-6 / ADR-0031): `targetHost` is the host
 * ONLY (never the full URL with query), `mappedFields` are the field NAMES only (never their values),
 * `method` is bounded to the HTTP-method set, and no request/response BODY is ever carried — the API
 * does not persist or return one by design. The UI renders only what the API returns and NEVER
 * un-redacts.
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
  /** The request method (bounded to the HTTP-method set), for a REST / WEBHOOK_OUT step. */
  method: string | null;
  /** The target HOST only — never the full URL with its query (which could carry a secret). */
  targetHost: string | null;
  errorClass: string | null;
  /** The NAMES of the fields the step mapped into its payload — never their values (INV-6). */
  mappedFields: string[];
  transitionTaken: WorkflowTransitionTaken | null;
  /** The ManualTask an ESCALATE edge opened (link to the inbox), if any. */
  manualTaskId: string | null;
  /** The step a COMPENSATE edge ran, if any. */
  compensationStepKey: string | null;
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
  signal?: AbortSignal,
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
  return apiFetch<Page<WorkflowRun>>(qs ? `${BASE}?${qs}` : BASE, { signal });
}

/** Fetch one run with its ordered step attempts and the traversed graph (`GET /workflow-runs/:id`). */
export function getWorkflowRun(
  id: string,
  signal?: AbortSignal,
): Promise<WorkflowRunDetail> {
  return apiFetch<WorkflowRunDetail>(`${BASE}/${id}`, { signal });
}

/**
 * The result of a manual retry — the resumed run + the step the re-run picked up from. Mirrors the
 * shared {@link RetryRunResponse} contract (ADR-0057): no override value is ever echoed back (INV-6).
 */
export type WorkflowRunRetryResult = RetryRunResponse;

/**
 * Manually retry a terminal FAILED run from the step that failed onward (`POST /workflow-runs/:id/retry`,
 * issue #308). RESUME-FROM-FAILED-STEP, not a full re-run: already-SUCCEEDED steps are NOT re-executed
 * (no double-provision). Gated `workflow:run`. The API rejects a non-FAILED run with a 409 and a run with
 * no resolvable failed step with a 422 — the caller surfaces those via `notifyError`.
 *
 * `overrides` (ADR-0057 Option 2) is an OPTIONAL, request-scoped payload override patched into the failed
 * step's data mapping for the NEXT attempt only — applied for one render and then DISCARDED, NEVER
 * persisted (INV-6). A plain retry omits it entirely and keeps the unchanged resume-from-failed-step
 * behaviour. The override does NOT edit the workflow definition and does NOT fix future runs.
 */
export function retryWorkflowRun(
  id: string,
  overrides?: RetryRunOverrides,
): Promise<WorkflowRunRetryResult> {
  // A plain retry sends NO body (the bodyless resume-from-failed-step path). Only attach `overrides`
  // when the operator actually supplied at least one field, matching the shared RetryRunRequestSchema.
  const hasOverrides = overrides != null && Object.keys(overrides).length > 0;
  return apiFetch<WorkflowRunRetryResult>(`${BASE}/${id}/retry`, {
    method: "POST",
    ...(hasOverrides ? { body: { overrides } } : {}),
  });
}

/** The result of a replay-latest clone — the NEW run on the latest version + the lineage breadcrumb. */
export type WorkflowRunReplayResult = ReplayLatestResponse;

/**
 * Clone-to-new-run from the LATEST workflow version (`POST /workflow-runs/:id/replay-latest`, ADR-0057
 * Option 3). Leaves the source FAILED run immutable and starts a FRESH run on the current version for the
 * same grant, beginning at the entry node — it adopts an edited definition the pinned-version retry can
 * never see. Gated `workflow:run`. The API rejects a non-FAILED source run with a 409 and refuses
 * (FAIL-CLOSED, 422) when the run already SUCCEEDED a non-idempotent create on/before the failed step —
 * the operator must RE-GRANT instead. The caller navigates to the returned `runId` (the new run).
 */
export function replayLatestWorkflowRun(
  id: string,
): Promise<WorkflowRunReplayResult> {
  return apiFetch<WorkflowRunReplayResult>(`${BASE}/${id}/replay-latest`, {
    method: "POST",
  });
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
  grantee: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    // ADR-0058 identity fields (null when not recorded). `manager` is a redaction-safe descriptor —
    // display name + live-manager email only — blank (null name/email) when none / offboarded.
    legajo: string | null;
    username: string | null;
    manager: { name: string | null; email: string | null; isOffboarded: boolean };
  };
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
