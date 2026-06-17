import type {
  ImportCommitResult,
  ImportDryRunReport,
  ImportEntity,
  ImportMapping,
  ImportResolutionPlan,
  ImportSessionAccepted,
  ImportSessionView,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Pure data-access functions for the guided bulk Migrator (ADR-0069, #637) — the ONLY place that
 * talks to `apiFetch` for the import wizard. Hooks (../hooks/use-imports.ts) wrap these in TanStack
 * Query; the wizard step components consume the hooks, never these directly (ADR-0020).
 *
 * Routes mirror apps/api/src/import/import.controller.ts. The whole surface is owner-scoped,
 * `import:run`-gated and human-only server-side (ADR-0069 §11) — the frontend gate (PermissionGate
 * on `import:run`) only hides the surface; the API is the real boundary. Every call can surface an
 * `ApiError` (403/404/409/413/4xx) the callers map to a localized message — never a silent dead-end.
 */
const BASE = "/imports";

/**
 * Start a bulk import (`POST /imports`, multipart, 202). Validates content-type + size synchronously
 * (413 on over-cap via multer), creates an owner-scoped session, enqueues the sandboxed parse and
 * returns `{ sessionId }`; poll {@link getImportSession} until the session reaches PARSED. `entity` is
 * Asset-only in phase 1 but sent for forward-compat (an unknown value 400s server-side).
 */
export function startImport(
  file: File,
  entity: ImportEntity = "asset",
): Promise<ImportSessionAccepted> {
  const form = new FormData();
  form.set("file", file);
  form.set("entity", entity);
  return apiFetch<ImportSessionAccepted>(BASE, { method: "POST", body: form });
}

/**
 * Poll a session (`GET /imports/:id`, owner-scoped): its status, the detected shape
 * (headers/dialect/encoding/rowCount) and the parsed rows. 404 for an unknown id or another owner's
 * session; `error` carries a PII-free `{ phase, message }` when the session is FAILED.
 */
export function getImportSession(
  id: string,
  signal?: AbortSignal,
): Promise<ImportSessionView> {
  return apiFetch<ImportSessionView>(`${BASE}/${id}`, { signal });
}

/**
 * Confirm the column/value/FK mapping for a PARSED session (`POST /imports/:id/mapping`) and advance
 * it to MAPPED. Returns the refreshed session view. 409 if the session isn't in a mappable status;
 * 400 if the mapping body is rejected (e.g. a required-no-default field with neither column nor
 * constant).
 */
export function setImportMapping(
  id: string,
  mapping: ImportMapping,
): Promise<ImportSessionView> {
  return apiFetch<ImportSessionView>(`${BASE}/${id}/mapping`, {
    method: "POST",
    body: mapping,
  });
}

/**
 * Run the dry-run for a MAPPED session (`POST /imports/:id/dry-run`) — WRITES NOTHING. Returns the
 * per-row outcomes, the deduped conflict set and the per-row asset-tag decisions for the operator to
 * resolve. 409 if the session isn't MAPPED.
 */
export function runImportDryRun(id: string): Promise<ImportDryRunReport> {
  return apiFetch<ImportDryRunReport>(`${BASE}/${id}/dry-run`, {
    method: "POST",
  });
}

/**
 * Freeze the operator's resolved conflict plan (`POST /imports/:id/plan`) and advance the session to
 * DRY_RUN. The plan is the immutable input the commit replays. Returns the refreshed session view.
 * 409 if the session isn't dry-run-resolved.
 */
export function saveImportPlan(
  id: string,
  plan: ImportResolutionPlan,
): Promise<ImportSessionView> {
  return apiFetch<ImportSessionView>(`${BASE}/${id}/plan`, {
    method: "POST",
    body: plan,
  });
}

/**
 * Commit a DRY_RUN session (`POST /imports/:id/commit`, 202) — ASYNC. Enqueues the chunked commit
 * that replays the frozen plan and returns `{ sessionId }`; poll {@link getImportResult}. Beyond
 * `import:run` the actor must hold the write permission for every entity the plan creates — a runtime
 * AND-check 403s a gap BEFORE any row is written (ADR-0069 §11). 409 if the session isn't committable.
 */
export function commitImport(id: string): Promise<ImportSessionAccepted> {
  return apiFetch<ImportSessionAccepted>(`${BASE}/${id}/commit`, {
    method: "POST",
  });
}

/**
 * Read the commit result (`GET /imports/:id/result`, owner-scoped): the status + the append-only
 * ImportRun ledger counts once a commit produced one (`counts`/`importRunId` are null while still
 * running — keep polling the session status until COMMITTED). 404 for an unknown / other-owner id.
 */
export function getImportResult(
  id: string,
  signal?: AbortSignal,
): Promise<ImportCommitResult> {
  return apiFetch<ImportCommitResult>(`${BASE}/${id}/result`, { signal });
}
