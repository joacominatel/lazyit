import { useQuery } from "@tanstack/react-query";
import type { User } from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Example hook that exercises the full web → api → @lazyit/shared chain.
 *
 * It hits GET /users (open, dev-only — see ADR-0016) purely to confirm the
 * wiring works end to end, and is intentionally NOT used in any page yet.
 *
 * NOTE: timestamps (createdAt / updatedAt / deletedAt) arrive as ISO strings
 * over the wire, not `Date` instances — parse them before treating them as
 * dates. The shared `User` type is reused here only as a structural reference.
 */
export function useHealth() {
  return useQuery({
    queryKey: ["health", "users"],
    queryFn: () => apiFetch<User[]>("/users"),
  });
}
