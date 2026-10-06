/**
 * The *Pending units* view (ADR-0099, UX proposal §3.f) and the open-line suggestions, pure. The API
 * returns the lines oldest purchase first; these helpers only group, total and flag them.
 */

import type { PendingPurchaseLine } from "@lazyit/shared";

/** One purchase's block in the Pending units view: its header and its pending lines, in API order. */
export interface PendingGroup {
  purchase: PendingPurchaseLine["purchaseOrder"];
  lines: PendingPurchaseLine[];
  /** Units still pending across the block's lines. */
  pending: number;
}

/** Group consecutive lines of the same purchase, keeping the API's oldest-first order. */
export function groupPendingLines(lines: readonly PendingPurchaseLine[]): PendingGroup[] {
  const groups: PendingGroup[] = [];
  const byId = new Map<string, PendingGroup>();
  for (const line of lines) {
    let group = byId.get(line.purchaseOrder.id);
    if (!group) {
      group = { purchase: line.purchaseOrder, lines: [], pending: 0 };
      byId.set(line.purchaseOrder.id, group);
      groups.push(group);
    }
    group.lines.push(line);
    group.pending += line.pendingQuantity;
  }
  return groups;
}

/** The view's footer: purchases shown and units pending on them. */
export function pendingTotals(groups: readonly PendingGroup[]): { purchases: number; units: number } {
  return {
    purchases: groups.length,
    units: groups.reduce((sum, group) => sum + group.pending, 0),
  };
}

/**
 * Overdue only when an expected date was set and is before `today` (`"YYYY-MM-DD"`, the viewer's day): a
 * purchase due today is not late yet.
 */
export function isOverdue(expectedDate: string | null, today: string): boolean {
  return expectedDate !== null && expectedDate.slice(0, 10) < today;
}

/** Open lines already mapped to this model — the "pending on a purchase" suggestion under a chosen model. */
export function pendingLinesForModel(
  lines: readonly PendingPurchaseLine[],
  modelId: string,
): PendingPurchaseLine[] {
  if (!modelId) return [];
  return lines.filter((line) => line.assetModelId === modelId && line.pendingQuantity > 0);
}

/**
 * The open lines a receive of ASSETS can take (#1476): `ASSET` lines only. A consumable line is received
 * into stock, never as assets, so the *From purchase* picker of Receive stock and New asset leaves it out.
 */
export function assetReceivableLines(lines: readonly PendingPurchaseLine[]): PendingPurchaseLine[] {
  return lines.filter((line) => line.kind === "ASSET");
}

/**
 * What *Receive* means for a line of this kind — the one place the screens decide it (#1477):
 *   - `ASSET`      → generate or link assets (*Receive stock* in purchase mode);
 *   - `CONSUMABLE` → *Receive into stock*, one movement on the line's consumable (#1476);
 *   - `LICENSE`    → *Apply license*: seats and renewal proposed to the line's application, applied on confirm;
 *   - anything else (`OTHER`, or a kind a newer build writes) → nothing to receive.
 * A license line must never reach an asset or stock receive, and an unknown kind must never be taken for an
 * asset line.
 */
export type LineReceiveAction = "receiveAssets" | "receiveStock" | "applyLicense";

export function lineReceiveAction(kind: string): LineReceiveAction | null {
  switch (kind) {
    case "ASSET":
      return "receiveAssets";
    case "CONSUMABLE":
      return "receiveStock";
    case "LICENSE":
      return "applyLicense";
    default:
      return null;
  }
}

/** The most pages {@link collectPages} reads for one list — a safety bound, far above a real backlog. */
export const MAX_COLLECTED_PAGES = 10;

/**
 * Read a paged list to its end: page after page while the pages read hold fewer items than `total`, up to
 * `maxPages`. For the open lines the *From purchase* picker offers (#1476): the API cannot filter lines by
 * kind, so with only the first page, consumable lines could push asset lines out of the picker.
 */
export async function collectPages<T>(
  fetchPage: (offset: number) => Promise<{ items: T[]; total: number }>,
  maxPages: number = MAX_COLLECTED_PAGES,
): Promise<{ items: T[]; total: number }> {
  const items: T[] = [];
  let total = 0;
  for (let page = 0; page < maxPages; page++) {
    const result = await fetchPage(items.length);
    total = result.total;
    items.push(...result.items);
    if (result.items.length === 0 || items.length >= total) break;
  }
  return { items, total };
}

/** The viewer's day as `"YYYY-MM-DD"` (local time — "today" is the day at the warehouse door). */
export function localToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
