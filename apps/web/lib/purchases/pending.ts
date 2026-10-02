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

/** The viewer's day as `"YYYY-MM-DD"` (local time — "today" is the day at the warehouse door). */
export function localToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
