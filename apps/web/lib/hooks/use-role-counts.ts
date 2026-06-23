import type { Role } from "@lazyit/shared";
import { useUserRoleCounts } from "@/lib/api/hooks/use-users";

/** Render order: privileged first. Shared by the Roles overview and the permissions config screen. */
export const ROLE_ORDER: Role[] = ["ADMIN", "MEMBER", "VIEWER"];

/**
 * Per-role LIVE holder counts (#693), straight from the server `GET /users/role-counts` endpoint (one
 * `groupBy`) — NOT the whole directory grouped client-side. The previous hook fetched up to the page
 * cap (200) and bucketed users in the browser, which both over-fetched and UNDERCOUNTED once a team
 * grew past the window. Returning just the counts keeps the Roles cards and the permissions screen
 * correct at any size; the actual membership lives in the Users list (`/users?role=…`).
 */
export function useRoleCounts(): {
  counts: Record<Role, number> | undefined;
  isLoading: boolean;
} {
  const { data: counts, isLoading } = useUserRoleCounts();
  return { counts, isLoading };
}
