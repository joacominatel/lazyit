import type { UpdateRolePermissions } from "@lazyit/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getMyPermissions,
  getPermissionMatrix,
  updatePermissionMatrix,
} from "../endpoints/config";

/**
 * Query keys for the Roles & Permissions v2 config surface (ADR-0046 P5/P7, ADR-0020 data layer).
 * Two keys under one root:
 *   - `matrix()`        → the editable role→permission matrix (ADMIN-only read; the config screen).
 *   - `mine()`          → the caller's OWN effective permissions (drives `can()` app-wide).
 * A write to the matrix invalidates BOTH — editing MEMBER/VIEWER can change what the *current* admin
 * (or any open session) is allowed to do, so the cached `can()` set must refetch too.
 */
export const permissionConfigKeys = {
  all: ["permissions-config"] as const,
  matrix: () => [...["permissions-config"], "matrix"] as const,
  mine: () => [...["permissions-config"], "mine"] as const,
};

/**
 * The full role→permission matrix (`GET /config/permissions`) — ADMIN-only (`settings:manage`). Feeds
 * the role config screen. Not cached aggressively: the matrix is authoritative config an admin is
 * actively editing, so a short staleness keeps a second tab in sync without a hard reload.
 */
export function usePermissionMatrix() {
  return useQuery({
    queryKey: permissionConfigKeys.matrix(),
    queryFn: getPermissionMatrix,
    staleTime: 30 * 1000,
  });
}

/**
 * The caller's OWN effective permissions (`GET /config/my-permissions`) — any authenticated user.
 * The source of truth for `can('domain:action')` (see `lib/hooks/use-permissions.ts`). Cached a few
 * minutes (the caller's role/permissions rarely change mid-session); invalidated by a matrix PUT so a
 * just-edited permission set is reflected without a reload.
 */
export function useMyPermissionsQuery() {
  return useQuery({
    queryKey: permissionConfigKeys.mine(),
    queryFn: getMyPermissions,
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Replace the MEMBER + VIEWER permission sets (`PUT /config/permissions`) — ADMIN-only. On success it
 * invalidates BOTH the matrix (so the screen re-reads the persisted truth, incl. the canonical ADMIN
 * row) AND the caller's effective permissions (so the app's `can()` gating reflects any change the
 * admin made to their *own* role's powers — rare, but possible). Toasts + dialog close are owned by
 * the calling screen.
 */
export function useUpdatePermissionMatrix() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateRolePermissions) => updatePermissionMatrix(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: permissionConfigKeys.matrix() });
      void queryClient.invalidateQueries({ queryKey: permissionConfigKeys.mine() });
    },
  });
}
