import type {
  ConfigStatus,
  MyPermissions,
  RolePermissionMatrix,
  SetupAdmin,
  SetupResult,
  UpdateRolePermissions,
} from "@lazyit/shared";
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
 *
 * `token` is the optional SSR Bearer override (ADR-0067): the Settings → Instance Server Component
 * passes `session.accessToken` from `await auth()` to prefetch this read. The endpoint is public (no
 * Bearer required), so a missing token is harmless; client callers omit it and `apiFetch` falls back
 * to the browser-only session-token store, unchanged.
 */
export function getConfigStatus(token?: string): Promise<ConfigStatus> {
  return apiFetch<ConfigStatus>(`${BASE}/status`, { token });
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

/* ──────────────────────────────────────────────────────────────────────────────────────────────
 * Roles & Permissions v2 — the configurable matrix (ADR-0046 P5/P7). These three require an ADMIN
 * Bearer (the read/update are gated `settings:manage`; my-permissions only needs authentication),
 * unlike the public first-run endpoints above. The wire shapes are the shared zod contracts.
 * ────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Read the full role→permission matrix (`GET /config/permissions`). ADMIN-only (`settings:manage`).
 * ADMIN is reported as the COMPLETE catalog (immutable/full); MEMBER/VIEWER are their stored rows.
 *
 * `token` is the optional SSR Bearer override (ADR-0067): the Settings → Roles → Permissions Server
 * Component passes `session.accessToken` from `await auth()` to prefetch the matrix; client callers
 * omit it and `apiFetch` falls back to the browser-only session-token store, unchanged.
 */
export function getPermissionMatrix(token?: string): Promise<RolePermissionMatrix> {
  return apiFetch<RolePermissionMatrix>(`${BASE}/permissions`, { token });
}

/**
 * Replace the MEMBER + VIEWER permission sets wholesale (`PUT /config/permissions`). ADMIN-only. The
 * body names ONLY the two editable roles (ADMIN is immutable — a smuggled ADMIN/extra key → 400); an
 * unknown permission → 400. Returns the new matrix.
 */
export function updatePermissionMatrix(
  body: UpdateRolePermissions,
): Promise<RolePermissionMatrix> {
  return apiFetch<RolePermissionMatrix>(`${BASE}/permissions`, {
    method: "PUT",
    body,
  });
}

/**
 * The caller's effective permissions (`GET /config/my-permissions`) — any authenticated user. Lets
 * the frontend derive `can('domain:action')` without polluting the `User` wire shape (ADMIN → the
 * complete catalog; MEMBER/VIEWER → their DB rows, exactly what the guard enforces).
 */
export function getMyPermissions(): Promise<MyPermissions> {
  return apiFetch<MyPermissions>(`${BASE}/my-permissions`);
}
