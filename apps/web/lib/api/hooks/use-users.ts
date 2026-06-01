import { useQuery } from "@tanstack/react-query";
import {
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
