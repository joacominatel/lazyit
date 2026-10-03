/**
 * Receiving a consumable line into stock (ADR-0099 Phase 1b, #1476) — the dialog's text → the
 * `POST /purchase-orders/:id/lines/:lineId/receive-stock` body. Pure, so the mapping is tested without React.
 *
 * The quantity is required by the API (a receipt is the count that arrived, typed at the door); the web
 * prefills it with the units still pending, so the common case is one click. Receiving past the pending
 * count is allowed and only warned about (ADR-0099 §4) — use `overReceipt` from the receive payload.
 */

import { type PurchaseOrderLine, type ReceiveStockFromLine, ReceiveStockFromLineSchema } from "@lazyit/shared";

/** The dialog's raw state: text as typed. */
export interface StockReceiveForm {
  quantity: string;
  note: string;
}

/** The form a stock receipt starts with: every pending unit (blank when nothing is pending), no note. */
export function stockReceivePrefill(line: Pick<PurchaseOrderLine, "pendingQuantity">): StockReceiveForm {
  return { quantity: line.pendingQuantity > 0 ? String(line.pendingQuantity) : "", note: "" };
}

/**
 * The quantity as a whole count, or `null` while it is not one (blank, decimals, signs, 0). The schema
 * still bounds it on submit.
 */
export function stockReceiveQuantity(text: string): number | null {
  const value = text.trim();
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 ? n : null;
}

/**
 * The request body: the quantity, and the note only when one was typed (trimmed). `ok: false` when the
 * quantity is not a whole count of at least 1 within the int4 bound — shown on the field.
 */
export function buildStockReceivePayload(
  form: StockReceiveForm,
): { ok: true; payload: ReceiveStockFromLine } | { ok: false } {
  const quantity = stockReceiveQuantity(form.quantity);
  if (quantity === null) return { ok: false };
  const note = form.note.trim();
  const parsed = ReceiveStockFromLineSchema.safeParse(note ? { quantity, note } : { quantity });
  return parsed.success ? { ok: true, payload: parsed.data } : { ok: false };
}
