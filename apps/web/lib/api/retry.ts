import { ApiError } from "./client";

/**
 * App-wide TanStack Query retry predicate (issues #935, #940).
 *
 * A 4xx from the API is a TERMINAL client-side outcome — 400 (bad request), 401 (expired session,
 * handled by `handleAuthExpiry`), 403 (permission denied) and 404 (missing/soft-deleted) will never
 * succeed on a retry. Retrying them only wastes ~7 s of exponential backoff, fires 3 extra doomed
 * GETs, and — worst — disguises a 403 as a flaky "the API may be down" error the user is invited to
 * retry forever. We settle immediately on any 4xx and keep up to 3 retries for genuinely transient
 * failures (5xx / network). Wired once as the QueryClient default (`app/providers.tsx`), so no
 * per-hook `retry` wiring is needed; hoisted to module level so the reference is stable across renders.
 *
 * (Promoted from the Secret Manager read hooks, where this exact policy first landed for #444; the
 * SM `retry.ts` now re-exports this so its hooks and the global default share one definition.)
 *
 * @param failureCount - number of attempts already made (0-indexed, same as TanStack's arg)
 * @param error        - the thrown error; expected to be `ApiError` for HTTP failures
 */
export const skip4xxRetry = (failureCount: number, error: Error): boolean =>
  !(error instanceof ApiError && error.status >= 400 && error.status < 500) &&
  failureCount < 3;
