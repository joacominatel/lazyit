import type {
  ManualInputField,
  ManualTask,
  ManualTaskStatus,
  Page,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data-access for `ManualTask` — the human-in-the-loop step queue (ADR-0054 §6). A run reaches a human
 * two ways (a MANUAL step, or a failure ESCALATE edge); both surface through the same inbox. The task
 * `prompt` and any provided values are UNTRUSTED context (grantee display name, free-form input) — the
 * UI renders them as escaped text only, never as HTML (SEC-A5).
 *
 * Backend contract (Phase 1b-B): `GET /workflow-tasks?status=&applicationId=` → `Page<ManualTask>`
 * (default PENDING); `GET /workflow-tasks/:id` → the task + `origin` + the `inputFields` to fill;
 * `POST /workflow-tasks/:id/submit { input }` | `/skip` | `/fail` → `{ ok, runId, resumeCursor }`.
 */

const BASE = "/workflow-tasks";

/** Where a task came from — a MANUAL step, or an escalated step failure. */
export type ManualTaskOrigin = "MANUAL_STEP" | "ESCALATED_FAILURE";

/**
 * One task with the detail the action form needs: its `origin` (drives the context copy) and the typed
 * `inputFields` the human fills (each may carry STATIC admin-typed `suggestions` — never a directory
 * lookup). Richer than the shared `ManualTask`, so declared here.
 */
export interface ManualTaskDetail extends ManualTask {
  origin: ManualTaskOrigin;
  inputFields: ManualInputField[];
}

/** The result of acting on a task — the resumed run + a cursor the FE can ignore beyond invalidation. */
export interface ManualTaskActionResult {
  ok: boolean;
  runId: string;
  resumeCursor?: string | null;
}

export interface WorkflowTaskFilters {
  /** Defaults to PENDING server-side when omitted. */
  status?: ManualTaskStatus;
  applicationId?: string;
  /** Page size (ADR-0030; 1-200). */
  limit?: number;
  /** Zero-based window offset (ADR-0030). */
  offset?: number;
}

/** List manual tasks (the inbox), filtered and paged. Returns the `Page<ManualTask>` envelope. */
export function getWorkflowTasks(
  filters: WorkflowTaskFilters = {},
): Promise<Page<ManualTask>> {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.applicationId) params.set("applicationId", filters.applicationId);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters.offset !== undefined)
    params.set("offset", String(filters.offset));
  const qs = params.toString();
  return apiFetch<Page<ManualTask>>(qs ? `${BASE}?${qs}` : BASE);
}

/** Fetch one task with its `origin` + `inputFields` (`GET /workflow-tasks/:id`). */
export function getWorkflowTask(id: string): Promise<ManualTaskDetail> {
  return apiFetch<ManualTaskDetail>(`${BASE}/${id}`);
}

/**
 * Submit a task: the typed `input` the human filled (`POST /workflow-tasks/:id/submit`). The server
 * validates it against the step's `inputFields`, records it and resumes the run at the correct next
 * step. The completer is gated by `workflow:task` AND a server-side assignee/cohort match.
 */
export function submitWorkflowTask(
  id: string,
  input: Record<string, unknown>,
): Promise<ManualTaskActionResult> {
  return apiFetch<ManualTaskActionResult>(`${BASE}/${id}/submit`, {
    method: "POST",
    body: { input },
  });
}

/** Skip an optional task step (`POST /workflow-tasks/:id/skip`) — the run resumes past it. */
export function skipWorkflowTask(
  id: string,
): Promise<ManualTaskActionResult> {
  return apiFetch<ManualTaskActionResult>(`${BASE}/${id}/skip`, {
    method: "POST",
  });
}

/** Fail the run from this task (`POST /workflow-tasks/:id/fail`), with an optional reason. */
export function failWorkflowTask(
  id: string,
  reason?: string,
): Promise<ManualTaskActionResult> {
  return apiFetch<ManualTaskActionResult>(`${BASE}/${id}/fail`, {
    method: "POST",
    body: reason ? { reason } : undefined,
  });
}
