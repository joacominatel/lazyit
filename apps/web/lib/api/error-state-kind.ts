import { ApiError } from "./client";

/**
 * Classifies a failed query's `error` for {@link ErrorState} (issue #1045).
 *
 * `'auth'` (401) and `'forbidden'` (403) look identical at the HTTP layer — both are
 * `ApiError`s in the 4xx range a retry can never fix — but they are NOT the same UX moment:
 * a 401 means the session itself is dead and `handleAuthExpiry` (providers.tsx) is already
 * signing the user out and redirecting to /login in the same tick, while a 403 means the
 * (still valid) session's role lacks permission and the "you don't have access" panel is the
 * correct, final state. Folding both into one `forbidden` branch (the pre-#1045 behavior) made
 * that panel flash for a moment before every auth-expiry redirect. Pulled out as a pure
 * function (mirrors the `handleAuthExpiry` / `skip4xxRetry` pattern) so the classification is
 * unit-testable without rendering anything.
 */
export type ErrorStateKind = "auth" | "forbidden" | "retry";

export function errorStateKind(error: unknown): ErrorStateKind {
  if (error instanceof ApiError) {
    if (error.status === 401) return "auth";
    if (error.status === 403) return "forbidden";
  }
  return "retry";
}
