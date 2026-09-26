import { ApiError } from "./client";

/**
 * Whether `error` is the API's `401 { code: "SESSION_REVOKED" }` (#1420, ADR-0086 §9): a password change
 * refused because a concurrent lever — an admin reset, a deactivation, a sign-out everywhere — ended the
 * caller's session first. Distinct from the change-password form's other 401 (a wrong current password),
 * which carries no code.
 */
export function isSessionRevoked(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 401) return false;
  const body = error.body as { code?: unknown } | null | undefined;
  return (
    typeof body === "object" && body !== null && body.code === "SESSION_REVOKED"
  );
}
