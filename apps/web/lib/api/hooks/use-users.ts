import { useQuery } from "@tanstack/react-query";
import { getUser, getUsers } from "../endpoints/users";
import { createQueryKeys } from "../query-keys";

/**
 * Query-key factory for the User resource (shape from `createQueryKeys`, see
 * ADR-0020): `all` → `["users"]`, `lists()` → `["users", "list"]`,
 * `detail(id)` → `["users", "detail", id]`. Mutations invalidate `all`.
 */
export const userKeys = createQueryKeys("users");

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
