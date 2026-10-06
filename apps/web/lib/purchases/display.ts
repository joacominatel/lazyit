/**
 * How a purchase reads on screen (ADR-0099) — pure, so the rules are tested without React. The
 * components translate what these return; nothing here formats words.
 */

import type { MoneyTotal, PurchaseOrderReceipt } from "@lazyit/shared";
import { formatMoney } from "@/lib/utils/money";

/** The fields a purchase's title is made from. */
export interface PurchaseTitleSource {
  reference: string | null;
  supplier: { name: string } | null;
  orderDate: string | null;
  createdAt: string;
}

/**
 * What a purchase is called (ADR-0099 §6): its finance reference when it has one; otherwise
 * *Supplier · date*; otherwise — a purchase identified only by its lines — *Purchase · date*. The date
 * is the order date, or the day it was recorded when there is none.
 */
export type PurchaseTitle =
  | { kind: "reference"; reference: string }
  | { kind: "supplier"; supplier: string; date: string }
  | { kind: "untitled"; date: string };

export function purchaseTitle(source: PurchaseTitleSource): PurchaseTitle {
  const reference = source.reference?.trim();
  if (reference) return { kind: "reference", reference };
  const date = source.orderDate ?? source.createdAt;
  const supplier = source.supplier?.name.trim();
  if (supplier) return { kind: "supplier", supplier, date };
  return { kind: "untitled", date };
}

/** The status a purchase shows: the stored one, refined by what was received. */
export type PurchaseDisplayStatus =
  | "draft"
  | "ordered"
  | "partial"
  | "received"
  | "over"
  | "cancelled"
  | "unknown";

/**
 * The displayed status (ADR-0099 §3): `DRAFT` and `CANCELLED` are shown as stored; an `ORDERED`
 * purchase reads as *Partially received*, *Received* or *Over-received* once units arrive. A status a
 * newer build wrote reads as `unknown` (shown as its raw text), never as an error.
 */
export function purchaseDisplayStatus(
  status: string,
  receipt: Pick<PurchaseOrderReceipt, "state"> | null,
): PurchaseDisplayStatus {
  switch (status) {
    case "DRAFT":
      return "draft";
    case "CANCELLED":
      return "cancelled";
    case "ORDERED":
      switch (receipt?.state) {
        case "PARTIAL":
          return "partial";
        case "RECEIVED":
          return "received";
        case "OVER":
          return "over";
        default:
          return "ordered";
      }
    default:
      return "unknown";
  }
}

/** The badge tone of each displayed status (UX proposal, Appendix B). Over-received is a warning. */
export const PURCHASE_STATUS_TONE = {
  draft: "neutral",
  ordered: "info",
  partial: "warning",
  received: "success",
  over: "warning",
  cancelled: "neutral",
  unknown: "neutral",
} as const satisfies Record<PurchaseDisplayStatus, string>;

/** One currency group of a total, ready to print. */
export interface TotalLine {
  /** Stable key for React (the trimmed, lower-cased label; `""` for no currency). */
  key: string;
  /** The amount with its label in front ("ARS 1.500"); `null` when the sum is too large to show exactly. */
  text: string | null;
  /** The group has no currency label — shown as its own visible state, never as a default currency. */
  noCurrency: boolean;
  /** Lines in this group with no price: the total is partial. */
  unpricedLines: number;
}

/**
 * A purchase's totals, one line per currency label exactly as the API grouped them — never summed or
 * converted across labels (ADR-0099 §5). An empty list (no lines) prints nothing.
 */
export function totalLines(totals: readonly MoneyTotal[], locale: string): TotalLine[] {
  return totals.map((total) => ({
    key: (total.currency ?? "").trim().toLowerCase(),
    text: total.amount === null ? null : formatMoney(total.amount, locale, total.currency),
    noCurrency: !total.currency?.trim(),
    unpricedLines: total.unpricedLines,
  }));
}

/** What a receipt progress reads: "x of y received", plus the pending and cancelled counts when any. */
export interface ReceiptProgress {
  received: number;
  ordered: number;
  pending: number;
  cancelled: number;
  /** More received than ordered (quantity − cancelled): a warning, never an error (ADR-0099 §4). */
  over: boolean;
  /** Received out of what is still expected (ordered − cancelled), 0–1, for a progress bar. */
  ratio: number;
}

export function receiptProgress(receipt: PurchaseOrderReceipt): ReceiptProgress {
  const expected = Math.max(receipt.ordered - receipt.cancelled, 0);
  return {
    received: receipt.received,
    ordered: receipt.ordered,
    pending: receipt.pending,
    cancelled: receipt.cancelled,
    over: receipt.received > expected,
    ratio: expected === 0 ? 1 : Math.min(receipt.received / expected, 1),
  };
}

/**
 * "Cancel purchase" is offered only while nothing has been received (ADR-0099 §3); a purchase with no
 * countable lines has received nothing.
 */
export function canCancelPurchase(
  status: string,
  receipt: Pick<PurchaseOrderReceipt, "received"> | null,
): boolean {
  return status !== "CANCELLED" && (receipt?.received ?? 0) === 0;
}
