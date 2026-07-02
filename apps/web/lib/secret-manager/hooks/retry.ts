/**
 * Retry predicate shared across ALL Secret Manager read hooks (ADR-0061, slice 3a — fix #444).
 *
 * 4xx responses from the SM API are TERMINAL client-side states (403 = non-member / vault locked;
 * 404 = broken handle / no membership / target has no keypair). Retrying them wastes ~7 s of
 * exponential backoff, fires 4 extra GETs (4N for N chips on an article), and hangs the chip
 * loading skeleton on a render-gating error state. We settle immediately on any 4xx and keep up
 * to 3 retries for genuine transient failures (5xx / network).
 *
 * This is now the SAME predicate the whole app defaults to (issue #935): the canonical definition
 * moved to `@/lib/api/retry` and is wired as the QueryClient default. This module re-exports it so
 * the Secret Manager hooks keep their explicit, self-documenting `retry: skip4xxRetry` and stay
 * pinned even if the global default ever changes.
 */
export { skip4xxRetry } from "@/lib/api/retry";
