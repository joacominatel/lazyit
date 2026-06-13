import { ApiError } from "@/lib/api/client";

/**
 * Retry predicate shared across ALL Secret Manager read hooks (ADR-0061, slice 3a — fix #444).
 *
 * 4xx responses from the SM API are TERMINAL client-side states (403 = non-member / vault locked;
 * 404 = broken handle / no membership / target has no keypair). Retrying them wastes ~7 s of
 * exponential backoff, fires 4 extra GETs (4N for N chips on an article), and hangs the chip
 * loading skeleton on a render-gating error state. We settle immediately on any 4xx and keep up
 * to 3 retries for genuine transient failures (5xx / network). Hoisted to module level so the
 * function reference is stable across renders and never triggers a spurious
 * `observerOptionsUpdated` on mount.
 *
 * @param failureCount - number of attempts already made (0-indexed, same as TanStack's arg)
 * @param error        - the thrown error; expected to be `ApiError` for HTTP failures
 */
export const skip4xxRetry = (failureCount: number, error: Error): boolean =>
  !(error instanceof ApiError && error.status >= 400 && error.status < 500) &&
  failureCount < 3;
