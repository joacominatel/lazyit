import type {
  ApplicationWorkflow,
  CreateApplicationWorkflow,
  CreateWorkflowVersion,
  Page,
  UpdateApplicationWorkflow,
  WorkflowVersion,
} from "@lazyit/shared";
import { ApiError } from "../client";
import { apiFetch } from "../client";

/**
 * Data-access for the Applications Workflow Engine definitions (ADR-0054, epic #248) — the opt-in
 * `ApplicationWorkflow` header + its immutable `WorkflowVersion` graph. Wire shapes come from
 * `@lazyit/shared`; the few enriched read shapes the engine returns but the shared contract does not
 * yet model (the workflow-with-latest-version composite, and the field-addressable graph-validation
 * 400) are declared here as thin FE view types over the shared primitives.
 *
 * Backend contract (Phase 1b-B): `GET/POST /workflows` (`?applicationId`, paged); `GET /workflows/:id`
 * → header + `latestVersion`; `PATCH`/`DELETE` (204) `/workflows/:id`; `POST /workflows/:id/versions`
 * authors a new immutable version, validates the whole graph and returns field-addressable 400s.
 */

const BASE = "/workflows";

/**
 * `GET /workflows/:id` returns the workflow header PLUS its latest authored version (the full step
 * graph), so the builder can render the diagram and re-open it for editing. `latestVersion` is null
 * for a freshly-created workflow that has never had a version authored.
 */
export interface WorkflowWithVersion extends ApplicationWorkflow {
  latestVersion: WorkflowVersion | null;
}

export interface WorkflowFilters {
  /** Scope to one application (the per-app Workflows tab). */
  applicationId?: string;
  /** Page size (ADR-0030; 1-200). Omit for the server default. */
  limit?: number;
  /** Zero-based window offset (ADR-0030). Omit for the first page. */
  offset?: number;
}

/** List workflows (optionally scoped to an application), paged per the `Page<T>` envelope (ADR-0030). */
export function getWorkflows(
  filters: WorkflowFilters = {},
): Promise<Page<ApplicationWorkflow>> {
  const params = new URLSearchParams();
  if (filters.applicationId) params.set("applicationId", filters.applicationId);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters.offset !== undefined)
    params.set("offset", String(filters.offset));
  const qs = params.toString();
  return apiFetch<Page<ApplicationWorkflow>>(qs ? `${BASE}?${qs}` : BASE);
}

/** Fetch one workflow with its latest version's full step graph (`GET /workflows/:id`). */
export function getWorkflow(id: string): Promise<WorkflowWithVersion> {
  return apiFetch<WorkflowWithVersion>(`${BASE}/${id}`);
}

/** Create an opt-in workflow header (disabled by default until a version is authored). */
export function createWorkflow(
  data: CreateApplicationWorkflow,
): Promise<ApplicationWorkflow> {
  return apiFetch<ApplicationWorkflow>(BASE, { method: "POST", body: data });
}

/** Patch a workflow header (name/description/enabled/deprovisionPolicy — trigger/app are immutable). */
export function updateWorkflow(
  id: string,
  data: UpdateApplicationWorkflow,
): Promise<ApplicationWorkflow> {
  return apiFetch<ApplicationWorkflow>(`${BASE}/${id}`, {
    method: "PATCH",
    body: data,
  });
}

/** Soft-delete a workflow (`DELETE /workflows/:id` → 204). */
export function deleteWorkflow(id: string): Promise<void> {
  return apiFetch<void>(`${BASE}/${id}`, { method: "DELETE" });
}

/**
 * Author a new immutable `WorkflowVersion` from the builder's step graph
 * (`POST /workflows/:id/versions`). The backend validates the whole graph and, on failure, returns a
 * field-addressable 400 (see {@link parseWorkflowGraphError}) the builder maps onto the offending box.
 */
export function createWorkflowVersion(
  id: string,
  data: CreateWorkflowVersion,
): Promise<WorkflowVersion> {
  return apiFetch<WorkflowVersion>(`${BASE}/${id}/versions`, {
    method: "POST",
    body: data,
  });
}

/** One unreachable-step entry from a graph-validation 400 (`{ index, key }`). */
export interface UnreachableStep {
  index: number;
  key: string;
}

/**
 * The two field-addressable shapes a `POST /workflows/:id/versions` 400 can carry: a set of
 * unreachable steps (`{ message, unreachableSteps }`), or a single field path into the steps array
 * (`{ message, path: ['steps', i, 'connectionId'] }`). The builder attaches each onto the right box.
 */
export interface WorkflowGraphError {
  message: string;
  /** Steps the validator could not reach from the trigger (attach a badge to each box). */
  unreachableSteps?: UnreachableStep[];
  /** A field path like `['steps', 2, 'connectionId']` — `stepIndex` is the offending box. */
  path?: (string | number)[];
  /** The step index the `path` addresses (the second segment), when present. */
  stepIndex?: number;
}

/**
 * Extract the field-addressable graph error from a failed `createWorkflowVersion` call, or null when
 * the error is not a structured 400 (e.g. a network error, a 401/403, or a plain message). Pure — the
 * builder calls it in the mutation's `onError` to decide which box(es) to flag.
 */
export function parseWorkflowGraphError(
  error: unknown,
): WorkflowGraphError | null {
  if (!(error instanceof ApiError) || error.status !== 400) return null;
  const body = error.body;
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const message =
    typeof record.message === "string" ? record.message : error.message;

  const unreachable = record.unreachableSteps;
  if (Array.isArray(unreachable)) {
    const unreachableSteps = unreachable
      .filter(
        (s): s is { index: number; key: string } =>
          typeof s === "object" &&
          s !== null &&
          typeof (s as { index?: unknown }).index === "number" &&
          typeof (s as { key?: unknown }).key === "string",
      )
      .map((s) => ({ index: s.index, key: s.key }));
    return { message, unreachableSteps };
  }

  const path = record.path;
  if (Array.isArray(path)) {
    const typedPath = path.filter(
      (segment): segment is string | number =>
        typeof segment === "string" || typeof segment === "number",
    );
    // The contract path is `['steps', <index>, ...]`; the numeric second segment is the box.
    const stepIndex =
      typedPath[0] === "steps" && typeof typedPath[1] === "number"
        ? typedPath[1]
        : undefined;
    return { message, path: typedPath, stepIndex };
  }

  return { message };
}
