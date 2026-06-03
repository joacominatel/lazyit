import { type Role, RoleSchema, type User } from "@lazyit/shared";
import { useMemo } from "react";
import { useUsers } from "@/lib/api/hooks/use-users";

/** Render order: privileged first. Shared by the Roles overview and the permissions config screen. */
export const ROLE_ORDER: Role[] = ["ADMIN", "MEMBER", "VIEWER"];

/** A user's display name, falling back to their email when no name is set. */
export function userFullName(user: User): string {
  return `${user.firstName} ${user.lastName}`.trim() || user.email;
}

/**
 * Group the active user directory by RBAC role (ADR-0040), sorted by display name within each role.
 * Extracted from the Roles overview so both that page and the permissions config screen derive holder
 * counts the same way (no drift). Defensive: only buckets known roles (`RoleSchema` is the source of
 * truth). Returns the grouping plus the underlying query's `isLoading` so callers can show skeletons.
 */
export function useUsersByRole(): {
  byRole: Record<Role, User[]>;
  isLoading: boolean;
} {
  const { data: users, isLoading } = useUsers();

  const byRole = useMemo(() => {
    const groups: Record<Role, User[]> = { ADMIN: [], MEMBER: [], VIEWER: [] };
    for (const user of users ?? []) {
      if (RoleSchema.options.includes(user.role)) groups[user.role].push(user);
    }
    for (const role of ROLE_ORDER) {
      groups[role].sort((a, b) => userFullName(a).localeCompare(userFullName(b)));
    }
    return groups;
  }, [users]);

  return { byRole, isLoading };
}
