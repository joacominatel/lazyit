import { apiFetch } from "../client";

/**
 * Sign out server-side (`POST /auth/logout`, authenticated; #1307, ADR-0086 §8). In local mode it bumps
 * the caller's `sessionEpoch`, which ends their sessions on EVERY device; it is a no-op 204 in OIDC mode.
 * A 401 means the token was already revoked. The current session Bearer is attached by `apiFetch`.
 */
export function logout(init: { signal?: AbortSignal } = {}): Promise<void> {
  return apiFetch<void>("/auth/logout", { method: "POST", ...init });
}
