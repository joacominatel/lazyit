import {
  MONEY_MAX,
  groupMoneyTotals,
  type MoneyTotal,
  type PurchaseOrderReceipt,
  type PurchaseOrderReceiptState,
} from '@lazyit/shared';

/**
 * The DERIVED purchase values (ADR-0099 §3): received / pending per line, the receipt state of a line and
 * of a purchase, and the totals. Nothing here is stored — received is the count of live assets linked to a
 * line (or, for a `CONSUMABLE` line, the units of the `IN` movements posted from it), read when it is shown,
 * so concurrent receives can never corrupt a counter (§4). Pure functions: the service feeds them rows and
 * counts.
 */

/**
 * The line kinds whose units are counted as received: `ASSET` (live linked assets), since Phase 1b (#1476)
 * `CONSUMABLE` (units moved in by its `IN` movements), and since Phase 2 (#1477) `LICENSE` (the seats a
 * person applied to its application). `OTHER` lines (shipping, services) are never pending, and a kind this
 * build does not know (written by a newer one) is shown but not counted.
 */
export const COUNTABLE_LINE_KINDS: readonly string[] = [
  'ASSET',
  'CONSUMABLE',
  'LICENSE',
];

/** The stored line values the derivation needs. */
export interface LineInput {
  kind: string;
  quantity: number;
  cancelledQuantity: number;
  unitPrice: bigint | null;
}

/** The derived values of one line. `lineTotal` stays a `bigint` so a sum never loses precision. */
export interface DerivedLine {
  countable: boolean;
  receivedQuantity: number;
  pendingQuantity: number;
  receiptState: PurchaseOrderReceiptState | null;
  lineTotal: bigint | null;
}

/** Whether a line of this kind has units to receive. */
export function isCountableKind(kind: string): boolean {
  return COUNTABLE_LINE_KINDS.includes(kind);
}

/**
 * Derive one line from its stored values and its received count (live linked assets, or stock moved in):
 *   - pending  = quantity − received − cancelled, floored at 0;
 *   - `OVER`   when more arrived than is still expected (received > quantity − cancelled) — allowed and
 *     surfaced, never blocked (ADR-0099 §4);
 *   - `RECEIVED` when nothing is pending (received + cancelled reaches the quantity);
 *   - `NONE` when nothing arrived yet, `PARTIAL` otherwise.
 * A line that is not countable has no state and nothing pending.
 */
export function deriveLine(line: LineInput, received: number): DerivedLine {
  const lineTotal =
    line.unitPrice === null
      ? null
      : BigInt(line.quantity) * BigInt(line.unitPrice);
  if (!isCountableKind(line.kind)) {
    return {
      countable: false,
      receivedQuantity: received,
      pendingQuantity: 0,
      receiptState: null,
      lineTotal,
    };
  }
  const expected = Math.max(line.quantity - line.cancelledQuantity, 0);
  const pending = Math.max(expected - received, 0);
  let receiptState: PurchaseOrderReceiptState;
  if (received > expected) receiptState = 'OVER';
  else if (pending === 0) receiptState = 'RECEIVED';
  else if (received === 0) receiptState = 'NONE';
  else receiptState = 'PARTIAL';
  return {
    countable: true,
    receivedQuantity: received,
    pendingQuantity: pending,
    receiptState,
    lineTotal,
  };
}

/** A line total as a wire amount: `null` when unknown or beyond `MONEY_MAX`. */
export function lineTotalToWire(total: bigint | null): number | null {
  return total === null || total > BigInt(MONEY_MAX) ? null : Number(total);
}

/**
 * The receipt of a purchase over its countable lines, or `null` when it has none. The purchase is
 * `RECEIVED` when nothing is pending anywhere (`OVER` if, in addition, some line received more than it
 * expected), `NONE` when nothing arrived, `PARTIAL` otherwise — a single over-received line next to a
 * pending one leaves the purchase `PARTIAL`, and the line itself shows `OVER`.
 */
export function derivePurchaseReceipt(
  lines: readonly (DerivedLine & LineInput)[],
): PurchaseOrderReceipt | null {
  const countable = lines.filter((line) => line.countable);
  if (countable.length === 0) return null;
  let ordered = 0;
  let received = 0;
  let cancelled = 0;
  let pending = 0;
  let over = false;
  for (const line of countable) {
    ordered += line.quantity;
    received += line.receivedQuantity;
    cancelled += line.cancelledQuantity;
    pending += line.pendingQuantity;
    over ||= line.receiptState === 'OVER';
  }
  let state: PurchaseOrderReceiptState;
  if (pending === 0) state = over ? 'OVER' : 'RECEIVED';
  else if (received === 0) state = 'NONE';
  else state = 'PARTIAL';
  return { state, ordered, received, cancelled, pending };
}

/**
 * A purchase's totals: every line in the purchase's one currency label, so one group (or none for a
 * purchase without lines). Grouping goes through the shared rule so a cross-purchase aggregate built on it
 * can never sum across labels (ADR-0099 §5).
 */
export function purchaseTotals(
  currency: string | null,
  lines: readonly DerivedLine[],
): MoneyTotal[] {
  return groupMoneyTotals(
    lines.map((line) => ({ currency, amount: line.lineTotal })),
  );
}
