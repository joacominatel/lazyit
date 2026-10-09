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

/** How many permission chips a row shows before collapsing the rest into "+N" (#1540). */
export const PERMISSION_CHIP_LIMIT = 3;

/** Split a permission list into the chips a row shows and how many collapse into "+N". */
export function permissionChips<T>(
  permissions: readonly T[],
  limit: number = PERMISSION_CHIP_LIMIT,
): { shown: T[]; hidden: T[] } {
  // Show the limit, unless only one would hide — "+1" saves no room over the chip itself.
  const cut = permissions.length <= limit + 1 ? permissions.length : limit;
  return { shown: permissions.slice(0, cut), hidden: permissions.slice(cut) };
}

/**
 * The lifecycle cell of a compact row: the status when it is not plain "active" (a badge), else when
 * the token expires (`expires`, with the date) or that it never does (`noExpiry`).
 */
export type LifecycleCell =
  | { kind: "status"; status: Exclude<ServiceAccountStatus, "active"> }
  | { kind: "expires"; at: string }
  | { kind: "noExpiry" };

export function lifecycleCell(account: ServiceAccount, now: number): LifecycleCell {
  const status = serviceAccountStatus(account, now);
  if (status !== "active") return { kind: "status", status };
  return account.expiresAt ? { kind: "expires", at: account.expiresAt } : { kind: "noExpiry" };
}
