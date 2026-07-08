import { ApiError } from "@/lib/api/client";

/**
 * How a failed "Create OIDC account" provisioning request should be surfaced (issue #1048).
 *   - `inline` — an actionable 400 the operator can fix (not a directory person / already linked /
 *     placeholder email / the IdP can't provision). Shown inline next to the button. `message` is the
 *     SERVER'S OWN text so the cause is honest; `null` means the server sent none and the caller should
 *     fall back to its generic hint. Critically this is NEVER a blanket "needs an email" — a
 *     `supportsManagement=false` 400 must read as "provisioning isn't available", not "add an email".
 *   - `toast` — any non-400 (e.g. a 503 the IdP create failed) is a transient, non-actionable failure.
 */
export type ProvisionErrorSurface =
  | { mode: "inline"; message: string | null }
  | { mode: "toast" };

/**
 * Classify a provision-account mutation error into how the UI should show it. Pure — no i18n, no React —
 * so the mapping is unit-testable without a DOM. A 400 carries the backend's real message; everything
 * else is a toast.
 */
export function classifyProvisionError(error: unknown): ProvisionErrorSurface {
  if (error instanceof ApiError && error.status === 400) {
    return { mode: "inline", message: error.message || null };
  }
  return { mode: "toast" };
}
