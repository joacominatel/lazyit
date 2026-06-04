import type { ServiceAccount } from "@lazyit/shared";
import type { StatusTone } from "@/components/ui/status-badge";

/**
 * The three operator-facing states of a service account (ADR-0048), derived (not stored) from the
 * row's lifecycle fields. Order of precedence below is deliberate:
 *   - `revoked`  — soft-deleted (`deletedAt` set): the token no longer authenticates. Wins over all.
 *   - `expired`  — `expiresAt` is in the past: rejected (401) on use, even though the row is live.
 *   - `inactive` — `isActive === false`: an explicit soft-disable distinct from revoke (a paused key).
 *   - `active`   — live, not expired, enabled: the token authenticates.
 */
export type ServiceAccountStatus = "active" | "inactive" | "expired" | "revoked";

/** Derive the {@link ServiceAccountStatus} for a row. `now` (epoch ms) is passed so render stays pure. */
export function serviceAccountStatus(
  account: ServiceAccount,
  now: number,
): ServiceAccountStatus {
  if (account.deletedAt) return "revoked";
  if (account.expiresAt && new Date(account.expiresAt).getTime() <= now) {
    return "expired";
  }
  if (!account.isActive) return "inactive";
  return "active";
}

/** The StatusBadge tone for each status (token-driven colors via StatusBadge). The visible label is
 * translated at render via `settings.serviceAccounts.status.<status>`. */
export const STATUS_TONE: Record<ServiceAccountStatus, StatusTone> = {
  active: "success",
  inactive: "neutral",
  expired: "warning",
  revoked: "danger",
};
