import type { ConfigStatus, SetupAdmin, SetupResult } from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Pure data-access functions for the first-run `/config` surface (ADR-0043 Phase 3) — the ONLY place
 * that talks to `apiFetch` for config. Hooks (../hooks/use-config-status.ts) wrap these in TanStack
 * Query; the `/setup` wizard + the topbar/Users banners consume the hooks. Routes mirror
 * apps/api/src/config. These endpoints are public (no Bearer required) so the wizard works before
 * any login exists.
 */
const BASE = "/config";

/**
 * First-run status (`GET /config/status`). Drives the wizard's self-lock (isConfigured), the IdP
 * choice (integrationMode), the topbar dev-mode banner (devMode) and carries the CSRF token the
 * setup POST must echo.
 */
export function getConfigStatus(): Promise<ConfigStatus> {
  return apiFetch<ConfigStatus>(`${BASE}/status`);
}

/**
 * Create the first ADMIN (`POST /config/setup`). The CSRF token (from the latest status payload, or
 * a fresh `GET /config/csrf`) is sent in the `X-CSRF-Token` header per the double-submit pattern the
 * backend validates. 409 once any ADMIN exists (the wizard self-locks before this in practice).
 */
export function setupConfig(
  data: SetupAdmin,
  csrfToken: string,
): Promise<SetupResult> {
  return apiFetch<SetupResult>(`${BASE}/setup`, {
    method: "POST",
    body: data,
    headers: { "X-CSRF-Token": csrfToken },
  });
}
