import type {
  CreateWorkflowConnection,
  WorkflowConnection,
  WorkflowConnectionConfig,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data-access for `WorkflowConnection` — the per-app "how do we reach this system + with what
 * credential" object (ADR-0054 §4). One connection, N workflows. The credential VALUE is never on a
 * connection wire shape (INV-6): `secretId` only references a separately-stored, write-only
 * {@link WorkflowSecret}.
 *
 * Backend contract (Phase 1b-B): `GET/POST /workflow-connections` (`?applicationId`); `GET /:id`;
 * `PATCH /:id { name?, config?, secretId? }` (the `kind` is immutable); `DELETE /:id` → 204.
 */

const BASE = "/workflow-connections";

/**
 * Patch a connection. `kind` is immutable (recreate to change it); `secretId: null` detaches the
 * credential. Shared models only the create DTO, so this PATCH shape is declared here.
 */
export interface UpdateWorkflowConnection {
  name?: string;
  config?: WorkflowConnectionConfig;
  secretId?: string | null;
}

/** List connections, optionally scoped to one application. */
export function getWorkflowConnections(
  applicationId?: string,
): Promise<WorkflowConnection[]> {
  const qs = applicationId
    ? `?${new URLSearchParams({ applicationId }).toString()}`
    : "";
  return apiFetch<WorkflowConnection[]>(`${BASE}${qs}`);
}

/** Fetch one connection by id. */
export function getWorkflowConnection(
  id: string,
): Promise<WorkflowConnection> {
  return apiFetch<WorkflowConnection>(`${BASE}/${id}`);
}

/** Create a connection (`config.kind` must equal the connection `kind`, enforced by the shared zod). */
export function createWorkflowConnection(
  data: CreateWorkflowConnection,
): Promise<WorkflowConnection> {
  return apiFetch<WorkflowConnection>(BASE, { method: "POST", body: data });
}

/** Patch a connection's name/config/secret reference (kind immutable). */
export function updateWorkflowConnection(
  id: string,
  data: UpdateWorkflowConnection,
): Promise<WorkflowConnection> {
  return apiFetch<WorkflowConnection>(`${BASE}/${id}`, {
    method: "PATCH",
    body: data,
  });
}

/** Soft-delete a connection (`DELETE /workflow-connections/:id` → 204). */
export function deleteWorkflowConnection(id: string): Promise<void> {
  return apiFetch<void>(`${BASE}/${id}`, { method: "DELETE" });
}
