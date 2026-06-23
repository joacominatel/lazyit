import { MAX_PAGE_LIMIT, type UserListItem } from "@lazyit/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  getCurrentUser,
  getUser,
  getUserAssignments,
  getUserGrants,
  getUserRoleCounts,
  getUsers,
  type UserListParams,
} from "../endpoints/users";
import { createQueryKeys, selectDirectoryItems } from "../query-keys";

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
  assignments: (id: string, activeOnly: boolean) =>
    [...baseUserKeys.detail(id), "assignments", activeOnly] as const,
  grants: (id: string, activeOnly: boolean) =>
    [...baseUserKeys.detail(id), "grants", activeOnly] as const,
};

/**
 * The full user directory as a flat `User[]` — for the screens that join users client-side (asset
 * owners, access grantees, article authors, the assign/grant dialogs). The list is paginated
 * server-side (ADR-0030), so this requests the hard-max page (200) to materialize the whole
 * directory for those lookups; the dedicated **Users list page** uses {@link useUserList} for real
 * paging. Returns just `items` so the existing `User[]` consumers are unchanged — but `select` warns
 * (dev) when the directory exceeds the cap so the truncation is never silent (issue #508).
 */
export function useUsers() {
  return useQuery({
    queryKey: userKeys.lists(),
    queryFn: ({ signal }) => getUsers({ limit: MAX_PAGE_LIMIT }, signal),
    // Pin the element generic: with the queryFn now taking the context arg, TanStack's overload no
    // longer back-infers the page item type into `select`, so name it to keep `data` as UserListItem[].
    select: selectDirectoryItems<UserListItem>("users"),
  });
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
