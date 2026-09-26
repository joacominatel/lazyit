import type { UserSessionList } from "@lazyit/shared";

import { apiFetch } from "../client";

/**
 * Sign out server-side (`POST /auth/logout`, authenticated; #1307, ADR-0086 §8). In local mode it bumps
 * the caller's `sessionEpoch`, which ends their sessions on EVERY device; it is a no-op 204 in OIDC mode.
 * A 401 means the token was already revoked. The current session Bearer is attached by `apiFetch`.
 */
export function logout(init: { signal?: AbortSignal } = {}): Promise<void> {
  return apiFetch<void>("/auth/logout", { method: "POST", ...init });
}

/**
 * The caller's own signed-in devices (`GET /auth/sessions`, #1420, ADR-0086 §9): most recent activity
 * first, `current` flags this device, and `currentIsLegacy` says this device's session predates the
 * per-device list (it has no row, so it cannot be ended on its own). Always empty outside local mode.
 */
export function listMySessions(): Promise<UserSessionList> {
  return apiFetch<UserSessionList>("/auth/sessions");
}

/**
 * End one of the caller's sessions (`DELETE /auth/sessions/:id`, 204). That device's token dies on its
 * next request; ending the CURRENT session therefore signs this device out. Any id that is not one of the
 * caller's live sessions (someone else's, unknown, already ended) is a 404.
 */
export function endMySession(id: string): Promise<void> {
  return apiFetch<void>(`/auth/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
