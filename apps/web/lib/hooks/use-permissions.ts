import type { Permission, Role } from "@lazyit/shared";
import { useMyPermissionsQuery } from "@/lib/api/hooks/use-permissions-config";
import { useCurrentUser } from "@/lib/api/hooks/use-users";

/**
 * Client-side RBAC derivation (ADR-0040) over the authenticated caller's role.
 *
 * This is a UI affordance only — it decides whether to *render* a write control, never whether a
 * write is *allowed*: the API's RolesGuard is the real gate, and every mutation is still enforced
 * server-side. The point is to stop showing affordances that will 403 (e.g. a VIEWER filling out a
 * form they can never submit).
 *
 * `canWrite` mirrors the spec's coarse rule — **ADMIN gates writes** — so `canWrite === isAdmin`.
 * The matrix in ADR-0040 is finer than that (MEMBER can do ordinary inventory/KB writes, while
 * Access-grant writes, Users administration and destructive deletes are ADMIN-only); for those
 * finer gates consume the role booleans directly (`isAdmin` / `isMember` / `isViewer`) rather than
 * widening `canWrite`. Keeping `canWrite` strict means a control hidden by it is never one the user
 * would be 403'd on.
 *
 * Loading / unauthenticated state is treated as **not** able to write: until the role is known we
 * fail closed, so the UI never briefly flashes a forbidden action before hiding it.
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
  /**
   * Whether to render write affordances. Equals {@link isAdmin} (ADMIN-gates-writes per the spec).
   * Defaults to `false` while the role is unknown (loading / error) so the UI fails closed.
   */
  canWrite: boolean;
  /** True while `/users/me` has not yet resolved (no role to derive from yet). */
  isLoading: boolean;
}

/**
 * Derive the caller's UI permissions from {@link useCurrentUser}. Pure and dependency-light: it adds
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
    // ADMIN-gates-writes (spec): canWrite === isAdmin. Fails closed while loading (isAdmin is false).
    canWrite: isAdmin,
    isLoading,
  };
}

/**
 * Convenience selector for the most common gate: "should this write control render?". Equivalent to
 * `usePermissions().canWrite`. Defaults to `false` while the role is loading.
 */
export function useCanWrite(): boolean {
  return usePermissions().canWrite;
}

/**
 * The caller's FINE-GRAINED permission set (Roles & Permissions v2, ADR-0046) over
 * `GET /config/my-permissions`. This is the permission-level counterpart to {@link usePermissions}'s
 * coarse role booleans: instead of "is the caller ADMIN?", it answers "does the caller hold permission
 * `X`?" via {@link can}.
 *
 * Additive and NON-breaking: the existing `useCanWrite()` / `isAdmin` gating is untouched and keeps
 * working off the role. The app-wide migration of gating call-sites to `can()` is a separate
 * follow-up — for now only the permissions matrix screen (and future call-sites) opt in.
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

  const permissions: ReadonlySet<Permission> = new Set(data?.permissions ?? []);

  return {
    role: data?.role,
    permissions,
    // Fails closed: an empty set while loading/errored means `can()` is false everywhere.
    can: (permission: Permission) => permissions.has(permission),
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
