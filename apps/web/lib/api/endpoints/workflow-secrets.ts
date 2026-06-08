import type { CreateWorkflowSecret, WorkflowSecret } from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data-access for `WorkflowSecret` — the engine's own AES-256-GCM credential store (ADR-0054 §5).
 * Credentials are **write-only from the UI**: reads return the REDACTED descriptor (`configured: true`
 * + a recognisable `label`), NEVER the cleartext (INV-6). The frontend therefore renders a masked,
 * non-refetchable field with a Replace control — the inverse of the service-account one-time reveal.
 *
 * Backend contract (Phase 1b-B): `GET /workflow-secrets` (`?applicationId`) + `GET /:id` → redacted;
 * `POST { applicationId, connectionId?, label, value }` (cleartext once); `PATCH /:id { value }`
 * (rotate); `DELETE /:id` → 204. The mutation results are also the redacted descriptor — the value is
 * never echoed back and is never written to the query cache.
 */

const BASE = "/workflow-secrets";

/** List redacted secret descriptors, optionally scoped to one application. Never carries a value. */
export function getWorkflowSecrets(
  applicationId?: string,
): Promise<WorkflowSecret[]> {
  const qs = applicationId
    ? `?${new URLSearchParams({ applicationId }).toString()}`
    : "";
  return apiFetch<WorkflowSecret[]>(`${BASE}${qs}`);
}

/** Fetch one redacted secret descriptor by id. Never carries a value. */
export function getWorkflowSecret(id: string): Promise<WorkflowSecret> {
  return apiFetch<WorkflowSecret>(`${BASE}/${id}`);
}

/**
 * Create a secret: the CLEARTEXT `value` is accepted once, encrypted server-side and NEVER returned.
 * The response is the redacted {@link WorkflowSecret} descriptor.
 */
export function createWorkflowSecret(
  data: CreateWorkflowSecret,
): Promise<WorkflowSecret> {
  return apiFetch<WorkflowSecret>(BASE, { method: "POST", body: data });
}

/** Rotate a secret's value (`PATCH /workflow-secrets/:id { value }`). Returns the redacted descriptor. */
export function rotateWorkflowSecret(
  id: string,
  value: string,
): Promise<WorkflowSecret> {
  return apiFetch<WorkflowSecret>(`${BASE}/${id}`, {
    method: "PATCH",
    body: { value },
  });
}

/** Soft-delete a secret (`DELETE /workflow-secrets/:id` → 204). */
export function deleteWorkflowSecret(id: string): Promise<void> {
  return apiFetch<void>(`${BASE}/${id}`, { method: "DELETE" });
}
