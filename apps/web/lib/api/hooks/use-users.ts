import { useQuery } from "@tanstack/react-query";
import { getUser, getUsers } from "../endpoints/users";

/**
 * Query-key factory for the User resource — the same shape as `locationKeys`
 * (ADR-0020), so the read hooks and the mutation hooks (which invalidate them)
 * can never drift:
 *
 * - `all`        → `["users"]`               — root/prefix for the whole resource
 * - `lists()`    → `["users", "list"]`       — the list query
 * - `detail(id)` → `["users", "detail", id]` — a single record
 *
 * Mutations invalidate `all`; being the common prefix, it refetches lists + details.
 */
export const userKeys = {
  all: ["users"] as const,
  lists: () => [...userKeys.all, "list"] as const,
  detail: (id: string) => [...userKeys.all, "detail", id] as const,
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
