import type { Role } from "@lazyit/shared";
import type { UserListParams } from "@/lib/api/endpoints/users";
import type { DerivedListState } from "@/lib/hooks/list-params-url";

/**
 * The SINGLE source for the users list's URL→query mapping — a framework-agnostic module (no
 * "use client") imported by BOTH the client `UsersListView` and the server `page.tsx` prefetch, so
 * their `userKeys.list(...)` keys can't drift (ADR-0067 / #733). See
 * `docs/04-development/ssr-prefetch-recipe.md`.
 */

/**
 * URL filter defaults. `status` (active/inactive) is filtered CLIENT-side over the page, so it never
 * enters the server query key. `archived` ("ALL" | "only") drives the ADMIN-only `deleted=only` view;
 * `directory` ("ALL" | "directory" | "accounts") drives the server `directoryOnly` slice; `role`
 * ("ALL" | ADMIN | MEMBER | VIEWER) drives the server `?role=` slice (#693).
 */
export const USER_FILTER_DEFAULTS = {
  status: "ALL",
  archived: "ALL",
  directory: "ALL",
  role: "ALL",
} as const;

/** `useListParams` config for the users list, shared client/server. */
export const USER_LIST_OPTIONS = {
  filters: USER_FILTER_DEFAULTS,
  defaultSort: "createdAt",
  defaultDir: "desc" as const,
};

/**
 * Map the URL-derived list state to the server `UserListParams`. `isAdmin` gates the archived
 * (`deleted=only`) slice exactly as the client does (API keeps it ADMIN-only). `directory` maps to the
 * three-way `directoryOnly` (`true`/`false`/omitted); `role` collapses "ALL" → `undefined`; `status`
 * is a client-side post-filter and stays out of the key.
 */
export function deriveUserParams(
  state: Pick<DerivedListState, "q" | "sort" | "dir" | "offset" | "limit" | "filters">,
  opts: { isAdmin: boolean },
): UserListParams {
  const { q, sort, dir, offset, limit, filters } = state;
  const directoryOnly =
    filters.directory === "directory"
      ? true
      : filters.directory === "accounts"
        ? false
        : undefined;
  return {
    q: q || undefined,
    sort,
    dir: sort ? dir : undefined,
    limit,
    offset,
    deleted: opts.isAdmin && filters.archived === "only" ? "only" : undefined,
    directoryOnly,
    role: filters.role !== "ALL" ? (filters.role as Role) : undefined,
  };
}
