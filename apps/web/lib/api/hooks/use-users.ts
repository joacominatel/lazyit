import { MAX_RESOLVE_USER_IDS, type UserListItem } from "@lazyit/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  getCurrentUser,
  getUser,
  getUserAssignments,
  getUserGrants,
  getUserRoleCounts,
  getUsers,
  type UserListParams,
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
  /** Per-role LIVE counts (`GET /users/role-counts`, #693) for the Settings → Roles cards. */
  roleCounts: () => [...baseUserKeys.all, "role-counts"] as const,
  /** A parameterized (search/sort/paged) list page — distinct from the bare directory `lists()`. */
  list: (params: UserListParams) => [...baseUserKeys.all, "list", params] as const,
  /**
   * A batch id→name resolution (`GET /users?ids=…`, #961). Keyed by the SORTED, de-duplicated id set so
   * two callers asking for the same users share one cache entry (and re-render order can't thrash it).
   */
  names: (ids: string[]) => [...baseUserKeys.all, "names", ids] as const,
  assignments: (id: string, activeOnly: boolean) =>
    [...baseUserKeys.detail(id), "assignments", activeOnly] as const,
  grants: (id: string, activeOnly: boolean) =>
    [...baseUserKeys.detail(id), "grants", activeOnly] as const,
};

/**
 * Stable empty lookup returned by {@link useUserNames} when there is nothing to resolve — a module-level
 * constant so the reference never changes (no spurious re-renders / effect churn in consumers).
 */
const EMPTY_USER_MAP: ReadonlyMap<string, UserListItem> = new Map();

/**
 * Batch id→name resolver (issue #961) — resolves a set of user ids to their rows for READ-ONLY name
 * lookups (history timelines, grantee chips, vault member chips, KB committed-rule names). It replaced
 * the whole-directory `useUsers()` hook, which materialized one hard-max page (200) and silently
 * degraded to an id fallback for any user past the cap. Backed by the list endpoint's `?ids=` filter
 * (`GET /users?ids=a,b,c`), so it resolves ANY referenced user regardless of directory size.
 *
 * The ids are de-duplicated and SORTED into a stable query key (shared cache across callers asking for
 * the same set, order-independent) and the batch is capped at `MAX_RESOLVE_USER_IDS` to match the
 * server bound — a larger set is sliced (never hit in a 5–20-person org). Returns a `Map<id, user>`:
 * a caller reads `.get(id)` for the name (`${firstName} ${lastName}`) or the whole row where a chip
 * needs it (avatars, Quick View). An unresolved id (soft-deleted, or beyond the cap) is simply absent
 * from the map, and the caller falls back to its own placeholder — exactly as before.
 *
 * `enabled` gates the fetch when the caller lacks `user:read` (would 403 — issue #935); the query is
 * also inert when there are no ids to resolve.
 */
export function useUserNames(
  ids: string[],
  { enabled = true }: { enabled?: boolean } = {},
): ReadonlyMap<string, UserListItem> {
  // De-duplicate + sort for a stable key, and cap to the server bound so a large set can't 400.
  const uniqueIds = useMemo(
    () => [...new Set(ids)].sort().slice(0, MAX_RESOLVE_USER_IDS),
    [ids],
  );
  const { data } = useQuery({
    queryKey: userKeys.names(uniqueIds),
    // Pair `ids` with `limit` = the id count so the single page returns every requested user (the ids
    // are capped at the page ceiling, so one page always suffices).
    queryFn: ({ signal }) =>
      getUsers({ ids: uniqueIds, limit: uniqueIds.length }, signal),
    select: (page) =>
      new Map(page.items.map((u) => [u.id, u] as const)) as ReadonlyMap<
        string,
        UserListItem
      >,
    enabled: enabled && uniqueIds.length > 0,
    // The resolved names rarely change within a session; a brief stale read is harmless.
    staleTime: 5 * 60 * 1000,
  });
  return data ?? EMPTY_USER_MAP;
}

/**
 * The Users list page: a single page of users with server-side `q`/`sort` and paging (returns the
 * `Page<User>` envelope so the page can render pagination + sortable headers). `keepPreviousData`
 * holds the current page while the next query resolves, so searching/paging doesn't flash the
 * skeleton.
 */
export function useUserList(params: UserListParams = {}) {
  return useQuery({
    queryKey: userKeys.list(params),
    queryFn: ({ signal }) => getUsers(params, signal),
    placeholderData: keepPreviousData,
  });
}

/**
 * Per-role LIVE user counts (`GET /users/role-counts`, #693) — the authoritative `{ ADMIN, MEMBER,
 * VIEWER }` the Settings → Roles cards render. One cheap server-side `groupBy`, so the counts are
 * correct at any team size; the cards link into the Users list (`/users?role=…`) for the membership
 * itself. Mutations invalidate `users.all`, which refetches this.
 */
export function useUserRoleCounts() {
  return useQuery({
    queryKey: userKeys.roleCounts(),
    queryFn: ({ signal }) => getUserRoleCounts(signal),
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
