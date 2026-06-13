import type { Permission, Role } from "@lazyit/shared";
import { useCallback, useMemo } from "react";
import { useMyPermissionsQuery } from "@/lib/api/hooks/use-permissions-config";
import { useCurrentUser } from "@/lib/api/hooks/use-users";

/**
 * Client-side RBAC role derivation (ADR-0040) over the authenticated caller's role.
 *
 * This is a UI affordance only — it decides whether to *render* a control, never whether an action is
 * *allowed*: the API's permission guard is the real gate, and every mutation is still enforced
 * server-side. The point is to stop showing affordances that will 403.
 *
 * Since the RBAC v2 gating migration (ADR-0046, P6b) the per-affordance write/delete gates use the
 * fine-grained {@link useCan} / {@link useMyPermissions} below. The coarse role booleans here remain
 * for the two things that are still genuinely role-shaped: the `role` (display, e.g. the user menu
 * badge) and `isAdmin` (the "Show archived" toggle — the API's `assertCanListDeleted` keeps the
 * `deleted=only` slice ADMIN-only, NOT a permission). Loading / unauthenticated state fails closed
 * (every boolean is `false`).
 */
export interface Permissions {
  /** The caller's RBAC role, or `undefined` while `/users/me` is loading (or on error). */
  role: Role | undefined;
  /** True only once the role is known to be ADMIN. */
  isAdmin: boolean;
  /** True only once the role is known to be MEMBER. */
  isMember: boolean;
  /** True only once the role is known to be VIEWER. */
  isViewer: boolean;
  /** True while `/users/me` has not yet resolved (no role to derive from yet). */
  isLoading: boolean;
}

/**
 * Derive the caller's UI role booleans from {@link useCurrentUser}. Pure and dependency-light: it adds
 * no state of its own, just maps the cached role to booleans. Cheap to call from many components —
 * the underlying `/users/me` query is shared and long-cached.
 */
export function usePermissions(): Permissions {
  const { data: user, isLoading } = useCurrentUser();
  const role = user?.role;

  const isAdmin = role === "ADMIN";
  const isMember = role === "MEMBER";
  const isViewer = role === "VIEWER";

  return {
    role,
    isAdmin,
    isMember,
    isViewer,
    isLoading,
  };
}

/**
 * The caller's FINE-GRAINED permission set (Roles & Permissions v2, ADR-0046) over
 * `GET /config/my-permissions`. This is the permission-level counterpart to {@link usePermissions}'s
 * coarse role booleans: instead of "is the caller ADMIN?", it answers "does the caller hold permission
 * `X`?" via {@link can}.
 *
 * This is now the PRIMARY gating primitive for write/delete affordances (the P6b migration replaced
 * the old role-coarse `useCanWrite()` everywhere). `usePermissions().isAdmin` survives only for the
 * archived-slice toggle, which the API keeps role-based.
 *
 * Fails CLOSED: while the query is loading or errored, the permission set is empty, so `can()` returns
 * `false` and a gated control stays hidden until the real set arrives — never a brief flash of an
 * action the API would 403.
 */
export interface MyPermissionsState {
  /** The caller's role, or `undefined` until `/config/my-permissions` resolves. */
  role: Role | undefined;
  /** The flat set of permissions the caller's role holds (empty while loading / on error). */
  permissions: ReadonlySet<Permission>;
  /** Whether the caller holds `permission`. Fails closed (false) while loading or on error. */
  can: (permission: Permission) => boolean;
  /** True while `/config/my-permissions` has not yet resolved. */
  isLoading: boolean;
  /** The query error, if the effective-permissions read failed. */
  error: unknown;
}

export function useMyPermissions(): MyPermissionsState {
  const { data, isLoading, error } = useMyPermissionsQuery();

  // SECW-02: memoize the Set so components that consume `permissions` or `can` do not re-render
  // on every parent render (a new Set literal is a new reference even when the contents are
  // identical). `data?.permissions` is the array reference from TanStack's cache — it only
  // changes when the query data itself changes, so this memo is very cheap to maintain.
  const permissions = useMemo<ReadonlySet<Permission>>(
    () => new Set(data?.permissions ?? []),
    [data?.permissions],
  );

  // Stable callback: `can` only changes when `permissions` changes, so downstream components
  // subscribed via `useCan` don't re-render on unrelated query updates.
  const can = useCallback(
    (permission: Permission) => permissions.has(permission),
    [permissions],
  );

  return {
    role: data?.role,
    permissions,
    // Fails closed: an empty set while loading/errored means `can()` is false everywhere.
    can,
    isLoading,
    error,
  };
}

/**
 * Convenience selector for a single permission gate: `can('settings:manage')`. Equivalent to
 * `useMyPermissions().can(permission)`. Fails closed (false) while the effective-permission set is
 * loading or on error. The API's `@RequirePermission` guard is still the real gate — this only decides
 * whether to *render* an affordance.
 */
export function useCan(permission: Permission): boolean {
  return useMyPermissions().can(permission);
}
