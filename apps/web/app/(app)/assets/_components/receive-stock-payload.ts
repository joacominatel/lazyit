/**
 * Pure form-to-wire glue for the bulk-receive (stock intake) dialog — ADR-0089 Part A.
 *
 * Extracted from the dialog (issue #1229) so the mapping can be unit-tested without mounting React:
 * the dialog now opens a NESTED "create model" dialog mid-flow, and the contract that must never
 * regress is that the model chosen last lands in `modelId` while every other typed field survives
 * untouched. Nothing here talks to the network or to React.
 *
 * The empty-field rules encoded here are load-bearing: blank optional id/date fields are OMITTED
 * (an empty string fails `cuid()` / `datetime()` in `ReceiveAssetsSchema`), money is parsed from
 * the MAJOR units the operator types in their locale to the minor units the wire carries (#954,
 * #1470), and `serials` is
 * absent — not `[]` — when nothing was pasted. `ReceiveAssetsSchema` remains the single validator.
 */

import { formatMoney, parseMoneyInput } from "@/lib/utils/money";
import { type AssetStatus, type PurchaseOrderLine, warrantyEndFrom } from "@lazyit/shared";

/**
 * The dialog's raw local state. Everything is a string because it comes straight from inputs; the
 * serials textarea is one serial per line and `purchaseCost` is major units as typed, in the
 * viewer's locale.
 */
export type ReceiveStockFormValues = {
  modelId: string;
  quantity: string;
  status: AssetStatus;
  locationId: string;
  company: string;
  purchaseDate: string;
  purchaseCost: string;
  notes: string;
  serials: string;
};

/** Split the serials textarea into trimmed, non-empty lines (one serial per unit). */
export function parseSerials(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Translate the dialog's local state into the payload `ReceiveAssetsSchema` validates.
 *
 * - `modelId` is forwarded verbatim — including an id that arrived from the inline create dialog.
 * - Blank `locationId` / `purchaseDate` are dropped (not `""`, which fails `cuid()` / `datetime()`).
 * - `company` / `notes` are trimmed and dropped when blank.
 * - `purchaseCost` goes through `parseMoneyInput` in `locale` (blank → `null`, the schema's "not
 *   set"). A refused amount becomes `NaN`, which the schema rejects — never a silent "not set". The
 *   dialog refuses it inline before getting here.
 * - `serials` is omitted entirely when the paste is empty.
 */
export function buildReceivePayload(
  values: ReceiveStockFormValues,
  locale: string,
): Record<string, unknown> {
  const cost = parseMoneyInput(values.purchaseCost, locale);
  const serialLines = parseSerials(values.serials);
  const company = values.company.trim();
  const notes = values.notes.trim();
  return {
    modelId: values.modelId,
    quantity: Number(values.quantity),
    status: values.status,
    ...(values.locationId ? { locationId: values.locationId } : {}),
    ...(company ? { company } : {}),
    ...(values.purchaseDate
      ? { purchaseDate: `${values.purchaseDate}T00:00:00.000Z` }
      : {}),
    purchaseCost: cost.ok ? cost.minor : Number.NaN,
    ...(notes ? { notes } : {}),
    ...(serialLines.length > 0 ? { serials: serialLines } : {}),
  };
}

// ── Receiving against a purchase line (ADR-0099, #1475) ──────────────────────────────────────────────

/**
 * The dialog's state in "from purchase line" mode: the plain fields plus the warranty end and the cost's
 * currency label, which come from the purchase.
 */
export type LineReceiveFormValues = ReceiveStockFormValues & {
  warrantyEnd: string;
  purchaseCurrency: string;
};

/** The purchase header values the prefill reads. */
export interface LineReceivePurchase {
  invoiceDate: string | null;
  currency: string | null;
  company: string | null;
  deliveryLocationId: string | null;
}

/** The line values the prefill reads. */
export type LineReceiveLine = Pick<
  PurchaseOrderLine,
  "assetModelId" | "unitPrice" | "warrantyMonths" | "pendingQuantity"
>;

/** Where the prefilled purchase date came from: the invoice date, else the day of the receipt. */
export type ReceiveDateSource = "INVOICE" | "TODAY";

/**
 * The form a receive from a line starts with (UX proposal §3.d) — the line's model, cost and warranty, the
 * purchase's company, delivery location and currency label, status *In storage*, and every pending unit.
 * The purchase date is the invoice date, else `today` (`"YYYY-MM-DD"`, the viewer's day) — never the
 * order date: the units arrive today, and the invoice date is what the auditor matches. The warranty end
 * is that date plus the line's warranty months, the same mapping the API uses (`purchaseLineValues`).
 */
export function lineReceivePrefill(
  purchase: LineReceivePurchase,
  line: LineReceiveLine,
  today: string,
  locale: string,
): { values: LineReceiveFormValues; dateSource: ReceiveDateSource } {
  const purchaseDate = purchase.invoiceDate ? purchase.invoiceDate.slice(0, 10) : today;
  const warrantyEnd = warrantyEndFrom(`${purchaseDate}T00:00:00.000Z`, line.warrantyMonths);
  return {
    values: {
      modelId: line.assetModelId ?? "",
      quantity: String(Math.max(line.pendingQuantity, 1)),
      status: "IN_STORAGE",
      locationId: purchase.deliveryLocationId ?? "",
      company: purchase.company ?? "",
      purchaseDate,
      purchaseCost: line.unitPrice === null ? "" : formatMoney(line.unitPrice, locale),
      purchaseCurrency: purchase.currency ?? "",
      warrantyEnd: warrantyEnd ? warrantyEnd.slice(0, 10) : "",
      notes: "",
      serials: "",
    },
    dateSource: purchase.invoiceDate ? "INVOICE" : "TODAY",
  };
}

/**
 * How many units the receive creates: the pasted serials when there are any — the quantity follows them,
 * so a count that does not match can never be sent — else the quantity typed (serial-less units).
 */
export function effectiveQuantity(quantity: string, serials: string): number {
  const count = parseSerials(serials).length;
  return count > 0 ? count : Number(quantity);
}

/**
 * The `ReceiveFromLineSchema` body. Every field is sent explicitly, because each one overrides the
 * purchase's prefill for this receive: a field the operator cleared is `null` (the units get no value),
 * never omitted (which would bring the purchase value back). The cost carries its currency label, and a
 * cleared cost clears the label with it — cost and currency move together (ADR-0099 §2). A refused amount
 * becomes `NaN`, which the schema rejects; the dialog stops it inline first.
 *
 * The one exception is the location: it is omitted while it is still the purchase's delivery location
 * (`prefill.locationId`), so the API applies the purchase's own value; it is sent only when the operator
 * changed it under *Change*, and as `null` only when they cleared it.
 */
export function buildReceiveFromLinePayload(
  values: LineReceiveFormValues,
  locale: string,
  prefill: Pick<LineReceiveFormValues, "locationId"> = { locationId: "" },
): Record<string, unknown> {
  const cost = parseMoneyInput(values.purchaseCost, locale);
  const serials = parseSerials(values.serials);
  const company = values.company.trim();
  const currency = values.purchaseCurrency.trim();
  const notes = values.notes.trim();
  const purchaseCost = cost.ok ? cost.minor : Number.NaN;
  return {
    quantity: effectiveQuantity(values.quantity, values.serials),
    ...(serials.length > 0 ? { serials } : {}),
    status: values.status,
    ...(values.modelId ? { modelId: values.modelId } : {}),
    ...(values.locationId === prefill.locationId ? {} : { locationId: values.locationId || null }),
    company: company || null,
    purchaseDate: values.purchaseDate ? `${values.purchaseDate}T00:00:00.000Z` : null,
    warrantyEnd: values.warrantyEnd ? `${values.warrantyEnd}T00:00:00.000Z` : null,
    purchaseCost,
    purchaseCurrency: purchaseCost !== null && currency ? currency : null,
    ...(notes ? { notes } : {}),
  };
}

/**
 * Over-receipt (ADR-0099 §4): receiving `receiving` more units onto `line`. `over` = the line would hold
 * more than it expects (quantity − cancelled) — a warning, never a refusal. `raiseTo` is the quantity
 * that makes it exact again, offered as the one-click "raise the line to n".
 */
export function overReceipt(
  line: Pick<PurchaseOrderLine, "quantity" | "cancelledQuantity" | "receivedQuantity">,
  receiving: number,
): { over: boolean; after: number; raiseTo: number } {
  const after = line.receivedQuantity + Math.max(receiving, 0);
  return {
    over: after > line.quantity - line.cancelledQuantity,
    after,
    raiseTo: after + line.cancelledQuantity,
  };
}
