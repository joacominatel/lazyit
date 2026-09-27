import type { ConsumableDelivery, ConsumableDeliveryPage } from "@lazyit/shared";

/**
 * The consumables side of the Offboarding sheet and the printable Return Act (ADR-0098, #1364). Pure:
 * the grouping of a leaver's deliveries, the operator's per-row selection, and how that selection
 * travels from the sheet to the act.
 *
 * Offboarding moves no stock and closes no delivery — these lists only tell the team what to ask for.
 */

/** One delivery, flattened for the sheet / act. */
export interface OffboardConsumableRow {
  /** The delivery (OUT movement) id — the stable key and the selection key. */
  deliveryId: number;
  consumableId: string;
  name: string;
  unit: string;
  /** The consumable has since been soft-deleted (its delivery still counts). */
  archived: boolean;
  /** Units delivered. */
  quantity: number;
  /** Units still owed back (0 for a non-returnable delivery). */
  outstanding: number;
  /** ISO datetime of the delivery. */
  deliveredAt: string;
}

export interface OffboardConsumables {
  /** Returnable deliveries with units still out — "Consumables to return". */
  toReturn: OffboardConsumableRow[];
  /** Non-returnable deliveries — "Consumables delivered", informational. */
  delivered: OffboardConsumableRow[];
  /** Outstanding deliveries beyond the fetched page (said out loud as "and N more"). */
  toReturnMore: number;
  /** Older deliveries (of any kind) beyond the fetched window of the all-deliveries read. */
  deliveredMore: number;
}

export const EMPTY_OFFBOARD_CONSUMABLES: OffboardConsumables = {
  toReturn: [],
  delivered: [],
  toReturnMore: 0,
  deliveredMore: 0,
};

function toRow(delivery: ConsumableDelivery): OffboardConsumableRow {
  return {
    deliveryId: delivery.id,
    consumableId: delivery.consumable.id,
    name: delivery.consumable.name,
    unit: delivery.consumable.unit,
    archived: delivery.consumable.deletedAt != null,
    quantity: delivery.quantity,
    outstanding: delivery.returnable ? delivery.outstandingQuantity : 0,
    deliveredAt: delivery.createdAt,
  };
}

/** Rows beyond what a page returned; never negative. */
function remaining(page: ConsumableDeliveryPage | undefined): number {
  return page ? Math.max(0, page.total - page.items.length) : 0;
}

/**
 * Group a leaver's deliveries from two reads:
 *  - `outstanding` — `outstandingOnly=true`. The AUTHORITATIVE list of what is owed back: a single
 *    "all deliveries" page would miss an old outstanding loaner behind newer consumed items, and a
 *    Return Act must never under-report.
 *  - `all` — every delivery, newest first; its NON-returnable rows are the informational group.
 * A fully-returned returnable delivery is settled and appears in neither group.
 */
export function groupOffboardConsumables(
  outstanding: ConsumableDeliveryPage | undefined,
  all: ConsumableDeliveryPage | undefined,
): OffboardConsumables {
  return {
    toReturn: (outstanding?.items ?? [])
      .filter((d) => d.returnable && d.outstandingQuantity > 0)
      .map(toRow),
    delivered: (all?.items ?? []).filter((d) => !d.returnable).map(toRow),
    toReturnMore: remaining(outstanding),
    deliveredMore: remaining(all),
  };
}

/** The rows the operator kept (every row is included unless its delivery id was excluded). */
export function selectOffboardConsumables(
  consumables: OffboardConsumables,
  excluded: ReadonlySet<number>,
): Pick<OffboardConsumables, "toReturn" | "delivered"> {
  return {
    toReturn: consumables.toReturn.filter((row) => !excluded.has(row.deliveryId)),
    delivered: consumables.delivered.filter((row) => !excluded.has(row.deliveryId)),
  };
}

/**
 * The query parameter that carries the per-row exclusions from the sheet to the printable act.
 *
 * Why the URL, not storage: the sheet opens the act with `window.open(…, "noopener")`, and a noopener
 * tab starts with an EMPTY sessionStorage (browsers only clone it for an opener-linked tab), so a
 * sessionStorage hand-off would silently print every row. localStorage would outlive this one act and
 * leak a stale selection into the next person's. The URL is explicit, per act, and survives a reload of
 * the act tab. Exclusions (not inclusions) are sent because the default is "everything listed".
 */
export const EXCLUDE_DELIVERIES_PARAM = "excludeDeliveries";

/** Parse the exclusions param ("12,15") into delivery ids, ignoring anything that is not a positive int. */
export function parseExcludedDeliveries(raw: string | null | undefined): Set<number> {
  const ids = new Set<number>();
  for (const part of (raw ?? "").split(",")) {
    const text = part.trim();
    if (!/^\d+$/.test(text)) continue;
    const id = Number(text);
    if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  }
  return ids;
}

/** The Return Act URL for a user, carrying the sheet's per-row exclusions (none → no param). */
export function offboardingActHref(
  userId: string,
  excluded: ReadonlySet<number>,
): string {
  const base = `/users/${encodeURIComponent(userId)}/offboarding/act`;
  if (excluded.size === 0) return base;
  const ids = [...excluded].sort((a, b) => a - b).join(",");
  return `${base}?${new URLSearchParams({ [EXCLUDE_DELIVERIES_PARAM]: ids })}`;
}
