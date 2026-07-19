import type {
  EnqueueUpdate,
  InstanceVersion,
  UpdateRun,
  UpdateSettings,
  UpdateStatus,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Pure data-access for the `/instance` identity surface (ADR-0083) — the ONLY place that talks to
 * `apiFetch` for it. The hook (../hooks/use-instance-version.ts) wraps it in TanStack Query; the
 * Settings → Instance view consumes the hook. Routes mirror apps/api/src/instance.
 */
const BASE = "/instance";

/**
 * The running build's version identity (`GET /instance/version`) — `{ current, gitSha }` baked into
 * the api image at build time (git tag via `git describe`; `"dev"`/`"unknown"` outside a build).
 * Authenticated read, no permission gate.
 *
 * `token` is the optional SSR Bearer override (ADR-0067): the Settings → Instance Server Component
 * passes `session.accessToken` to prefetch this read; client callers omit it and `apiFetch` falls
 * back to the browser-only session-token store, unchanged.
 */
export function getInstanceVersion(token?: string): Promise<InstanceVersion> {
  return apiFetch<InstanceVersion>(`${BASE}/version`, { token });
}

/**
 * The "Version & updates" card read (`GET /instance/update-status`, ADR-0084, `settings:read`) — running
 * version, opt-in state, latest known release + N behind, last checked, the active run + recent history.
 * Reads the server-side cache; never fetches GitHub. `token` is the optional SSR Bearer override.
 */
export function getUpdateStatus(token?: string): Promise<UpdateStatus> {
  return apiFetch<UpdateStatus>(`${BASE}/update-status`, { token });
}

/** The update-check opt-in setting (`GET /instance/update-settings`, `settings:read`). */
export function getUpdateSettings(token?: string): Promise<UpdateSettings> {
  return apiFetch<UpdateSettings>(`${BASE}/update-settings`, { token });
}

/** Flip the opt-in weekly GitHub update check (`PUT /instance/update-settings`, `settings:manage`). */
export function putUpdateSettings(
  body: UpdateSettings,
): Promise<UpdateSettings> {
  return apiFetch<UpdateSettings>(`${BASE}/update-settings`, {
    method: "PUT",
    body,
  });
}

/**
 * ENQUEUE a guided update (`POST /instance/update`, `settings:manage`, human-only). Records an
 * append-only UpdateRun and returns it; the UI then shows the operator the `./infra/update.sh` command.
 * This executes NOTHING on the host — it only records intent (ADR-0084 §4).
 */
export function enqueueUpdate(body: EnqueueUpdate): Promise<UpdateRun> {
  return apiFetch<UpdateRun>(`${BASE}/update`, {
    method: "POST",
    body,
  });
}

/**
 * CANCEL a stuck `requested` update (`POST /instance/update/cancel`, `settings:manage`, human-only,
 * issue #1065). Moves a run the operator enqueued but never ran on the host to the terminal `failed`
 * state so a fresh update can be enqueued. The API rejects this for a genuinely in-flight run.
 */
export function cancelUpdate(): Promise<UpdateRun> {
  return apiFetch<UpdateRun>(`${BASE}/update/cancel`, {
    method: "POST",
  });
}
