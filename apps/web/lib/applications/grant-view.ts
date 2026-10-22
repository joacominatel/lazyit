import type { Application, ApplicationGrantSummary } from "@lazyit/shared";
import { NO_ACCESS_LEVEL } from "./grant-list-query";

// The Access tab reads one page of grants plus a summary over all of them (#1660); these turn the
// summary into what the page shows. The filtering and ordering themselves run on the server.

/** The level picker's options, in the server's order (alphabetical, "no level" last). */
export function accessLevelOptions(
  levels: ApplicationGrantSummary["levels"],
): { level: string; count: number }[] {
  return levels.map(({ accessLevel, count }) => ({
    level: accessLevel ?? NO_ACCESS_LEVEL,
    count,
  }));
}

/**
 * The picker earns its place when there is a choice to make, and stays while a level is selected so a
 * filter carried in from a link can always be cleared.
 */
export function showAccessLevelPicker(
  options: readonly { level: string }[],
  selection: string,
  anyLevel: string,
): boolean {
  return options.length > 1 || selection !== anyLevel;
}

/**
 * The "Needs attention" split. The summary's `expiring` already includes the `expired` grants the sweep
 * has not revoked yet; the page reports those two apart.
 */
export function grantAttention(counts: ApplicationGrantSummary["counts"]): {
  expired: number;
  expiringSoon: number;
} {
  return {
    expired: counts.expired,
    expiringSoon: Math.max(0, counts.expiring - counts.expired),
  };
}

export interface SeatState {
  used: number;
  /** `null` when seats are not tracked. */
  purchased: number | null;
  overBy: number;
  free: number;
  /** used / purchased for the meter; `null` when untracked or zero seats were bought. */
  fill: number | null;
}

export function seatState(
  application: Pick<Application, "seatsPurchased" | "seatsUsed">,
): SeatState {
  const used = application.seatsUsed ?? 0;
  const purchased = application.seatsPurchased ?? null;
  if (purchased === null) return { used, purchased, overBy: 0, free: 0, fill: null };
  return {
    used,
    purchased,
    overBy: Math.max(0, used - purchased),
    free: Math.max(0, purchased - used),
    fill: purchased > 0 ? used / purchased : null,
  };
}
