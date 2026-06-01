import { useQuery } from "@tanstack/react-query";
import {
  getCurrentUser,
  getUser,
  getUserAssignments,
  getUserGrants,
  getUsers,
} from "../endpoints/users";
import { createQueryKeys } from "../query-keys";

/**
 * Query-key factory for the User resource (shape from `createQueryKeys`, see
 * ADR-0020): `all` → `["users"]`, `lists()` → `["users", "list"]`,
 * `detail(id)` → `["users", "detail", id]`. Two nested keys (a user's asset
 * assignments + access grants) sit under the detail so invalidating `all` (or a
 * detail) also refetches the asset-centric per-person panels. Mutations
 * invalidate `all`.
 */
const baseUserKeys = createQueryKeys("users");
export const userKeys = {
  ...baseUserKeys,
  /** The authenticated caller (`GET /users/me`) — distinct from any `detail(id)`. */
  me: () => [...baseUserKeys.all, "me"] as const,
  assignments: (id: string, activeOnly: boolean) =>
    [...baseUserKeys.detail(id), "assignments", activeOnly] as const,
  grants: (id: string, activeOnly: boolean) =>
    [...baseUserKeys.detail(id), "grants", activeOnly] as const,
};

/** List all (non-soft-deleted) users. */
export function useUsers() {
  return useQuery({
    queryKey: userKeys.lists(),
    queryFn: getUsers,
  });
}

/**
 * The current authenticated user (`GET /users/me`), used mainly to read the caller's RBAC role
 * (ADR-0040) — the OIDC token does not carry it. The role drives whether admin-only controls (like
 * the role Select) render. Cached longer than list data: the caller's own role rarely changes within
 * a session, and a stale read only briefly under- or over-shows a control that the API still gates.
 */
export function useCurrentUser() {
  return useQuery({
    queryKey: userKeys.me(),
    queryFn: getCurrentUser,
    staleTime: 5 * 60 * 1000,
  });
}

/** Fetch a single user by id; idle until an id is provided. */
export function useUser(id: string | undefined) {
  return useQuery({
    queryKey: userKeys.detail(id ?? ""),
    queryFn: () => getUser(id as string),
    enabled: Boolean(id),
  });
}

/** A user's asset assignments (active by default; pass false for the full history). */
export function useUserAssignments(id: string | undefined, activeOnly = true) {
  return useQuery({
    queryKey: userKeys.assignments(id ?? "", activeOnly),
    queryFn: () => getUserAssignments(id as string, activeOnly),
    enabled: Boolean(id),
  });
}

/** A user's access grants (active by default; pass false to include revoked). */
export function useUserGrants(id: string | undefined, activeOnly = true) {
  return useQuery({
    queryKey: userKeys.grants(id ?? "", activeOnly),
    queryFn: () => getUserGrants(id as string, activeOnly),
    enabled: Boolean(id),
  });
}
