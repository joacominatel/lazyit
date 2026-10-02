/**
 * The purchase form's text → the API payloads (ADR-0099, ADR-0100). Pure, so the mapping is tested
 * without React. Entry is light (CEO decision D-D): nothing is required beyond what the API needs, a blank
 * field is simply absent on create and cleared (`null`) on edit, and a blank line is ignored.
 *
 * Amounts are typed in the viewer's locale and parsed with `parseMoneyInput` — a refused amount is an
 * error on that field, never guessed.
 */

import {
  type CreatePurchaseOrder,
  type CreatePurchaseOrderLine,
  PURCHASE_ORDER_LINE_KINDS,
  type PurchaseOrder,
  type PurchaseOrderLine,
  type PurchaseOrderLineKind,
  type PurchaseOrderStatus,
  type UpdatePurchaseOrder,
  type UpdatePurchaseOrderLine,
} from "@lazyit/shared";
import { formatMoney, type MoneyParseError, parseMoneyInput } from "@/lib/utils/money";

/** The purchase header as the form holds it: text, `""` for blank. */
export interface PurchaseHeaderDraft {
  reference: string;
  status: PurchaseOrderStatus;
  currency: string;
  /** Date inputs: `"YYYY-MM-DD"` or `""`. */
  orderDate: string;
  expectedDate: string;
  invoiceDate: string;
  invoiceNumbers: string;
  company: string;
  /** A location id or `""`. */
  deliveryLocationId: string;
  notes: string;
}

/** One line as the form holds it. */
export interface LineDraft {
  /** Client-side identity of the row (React key, error map key). */
  key: string;
  /**
   * `ASSET`, `CONSUMABLE` or `OTHER` — the kinds this build writes. A saved line of a kind a newer build
   * added keeps its raw value here, is shown read-only and is never rewritten.
   */
  kind: string;
  description: string;
  manufacturerText: string;
  modelText: string;
  /** An asset model id or `""`. */
  assetModelId: string;
  /** On a `CONSUMABLE` line, the consumable it is received into, or `""` (mapped later, at the latest when receiving). */
  consumableId: string;
  /** Digits; blank = 1. */
  quantity: string;
  /** Money text in the viewer's locale; blank = unknown price. */
  unitPrice: string;
  /** Digits; blank = none. */
  warrantyMonths: string;
}

/** Why a line field was refused. */
export interface LineErrors {
  description?: "required";
  quantity?: "invalid";
  unitPrice?: MoneyParseError;
  warrantyMonths?: "invalid";
}

/** The largest int4 the API accepts for a count (ADR-0036). */
const INT4_MAX = 2_147_483_647;
/** Warranty months accepted on write (up to 100 years). */
const WARRANTY_MAX = 1200;

export function emptyHeaderDraft(): PurchaseHeaderDraft {
  return {
    reference: "",
    status: "ORDERED",
    currency: "",
    orderDate: "",
    expectedDate: "",
    invoiceDate: "",
    invoiceNumbers: "",
    company: "",
    deliveryLocationId: "",
    notes: "",
  };
}

export function emptyLineDraft(key: string): LineDraft {
  return {
    key,
    kind: "ASSET",
    description: "",
    manufacturerText: "",
    modelText: "",
    assetModelId: "",
    consumableId: "",
    quantity: "1",
    unitPrice: "",
    warrantyMonths: "",
  };
}

/** ISO datetime → `"YYYY-MM-DD"` for a date input (`""` when absent). */
export function isoToDateInput(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "";
}

/** `"YYYY-MM-DD"` → an ISO datetime at UTC midnight (`undefined` when blank), as the asset form does. */
export function dateInputToIso(value: string): string | undefined {
  return value ? new Date(`${value}T00:00:00.000Z`).toISOString() : undefined;
}

/** A line nobody typed into (the quantity alone at its default does not count). */
export function isBlankLine(line: LineDraft): boolean {
  return (
    line.description.trim() === "" &&
    line.manufacturerText.trim() === "" &&
    line.modelText.trim() === "" &&
    line.assetModelId === "" &&
    line.consumableId === "" &&
    (line.quantity.trim() === "" || line.quantity.trim() === "1") &&
    line.unitPrice.trim() === "" &&
    line.warrantyMonths.trim() === ""
  );
}

/** The kinds this build may write (a line's kind selector offers only these). */
export function isWritableKind(kind: string): kind is PurchaseOrderLineKind {
  return (PURCHASE_ORDER_LINE_KINDS as readonly string[]).includes(kind);
}

/** A whole count in `[min, max]` typed as digits, `null` when blank, `"invalid"` otherwise. */
function parseCount(text: string, min: number, max: number): number | null | "invalid" {
  const value = text.trim();
  if (value === "") return null;
  if (!/^\d+$/.test(value)) return "invalid";
  const n = Number(value);
  return n >= min && n <= max ? n : "invalid";
}

/** The parsed values of a line, or its errors. Blank quantity reads as 1 ("defaults to 1"). */
function parseLine(
  line: LineDraft,
  locale: string,
):
  | {
      ok: true;
      description: string;
      quantity: number;
      unitPrice: number | null;
      warrantyMonths: number | null;
    }
  | { ok: false; errors: LineErrors } {
  const errors: LineErrors = {};
  const description = line.description.trim();
  if (description === "") errors.description = "required";
  const quantity = parseCount(line.quantity, 1, INT4_MAX);
  if (quantity === "invalid") errors.quantity = "invalid";
  const price = parseMoneyInput(line.unitPrice, locale);
  if (!price.ok) errors.unitPrice = price.error;
  const warranty = parseCount(line.warrantyMonths, 0, WARRANTY_MAX);
  if (warranty === "invalid") errors.warrantyMonths = "invalid";
  if (Object.keys(errors).length > 0 || quantity === "invalid" || warranty === "invalid" || !price.ok) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    description,
    quantity: quantity ?? 1,
    unitPrice: price.minor,
    warrantyMonths: warranty,
  };
}

/** Validate one line on its own (used to show errors as the operator leaves it). */
export function lineErrors(line: LineDraft, locale: string): LineErrors {
  const parsed = parseLine(line, locale);
  return parsed.ok ? {} : parsed.errors;
}

/**
 * A line → the create payload: only what was filled is sent, so the API applies its defaults (kind,
 * quantity 1). Model fields go on an `ASSET` line only — shipping or a service has no maker — and the
 * consumable on a `CONSUMABLE` line only (the API refuses it elsewhere).
 */
export function toCreateLine(
  line: LineDraft,
  locale: string,
): { ok: true; line: CreatePurchaseOrderLine } | { ok: false; errors: LineErrors } {
  const parsed = parseLine(line, locale);
  if (!parsed.ok) return parsed;
  const out: CreatePurchaseOrderLine = { description: parsed.description };
  if (line.kind !== "ASSET" && isWritableKind(line.kind)) out.kind = line.kind;
  if (parsed.quantity !== 1) out.quantity = parsed.quantity;
  if (parsed.unitPrice !== null) out.unitPrice = parsed.unitPrice;
  if (line.kind === "ASSET") {
    const manufacturer = line.manufacturerText.trim();
    const model = line.modelText.trim();
    if (manufacturer) out.manufacturerText = manufacturer;
    if (model) out.modelText = model;
    if (line.assetModelId) out.assetModelId = line.assetModelId;
    if (parsed.warrantyMonths !== null) out.warrantyMonths = parsed.warrantyMonths;
  }
  if (line.kind === "CONSUMABLE" && line.consumableId) out.consumableId = line.consumableId;
  return { ok: true, line: out };
}

/** The header fields a create sends when filled (trimmed; blank = absent). */
function headerFields(header: PurchaseHeaderDraft) {
  const text = (value: string) => value.trim() || undefined;
  return {
    reference: text(header.reference),
    currency: text(header.currency),
    orderDate: dateInputToIso(header.orderDate),
    expectedDate: dateInputToIso(header.expectedDate),
    invoiceDate: dateInputToIso(header.invoiceDate),
    invoiceNumbers: text(header.invoiceNumbers),
    company: text(header.company),
    deliveryLocationId: header.deliveryLocationId || undefined,
    notes: text(header.notes),
  };
}

export type CreatePurchaseResult =
  | { ok: true; payload: CreatePurchaseOrder }
  | {
      ok: false;
      /** Errors per line key. */
      lineErrors: Record<string, LineErrors>;
      /** Nothing identifies the purchase: no supplier, no reference, no line (ADR-0099 §2). */
      unidentified: boolean;
    };

/**
 * The create form → `POST /purchase-orders`. Blank lines are ignored; a line with anything typed needs
 * a description. The purchase must be identifiable by a supplier, a reference or one line — the same rule
 * the API enforces, checked here so the operator sees it before the request.
 */
export function toCreatePurchase(
  header: PurchaseHeaderDraft,
  supplierId: string | undefined,
  lines: readonly LineDraft[],
  locale: string,
): CreatePurchaseResult {
  const errors: Record<string, LineErrors> = {};
  const created: CreatePurchaseOrderLine[] = [];
  for (const line of lines) {
    if (isBlankLine(line)) continue;
    const result = toCreateLine(line, locale);
    if (result.ok) created.push(result.line);
    else errors[line.key] = result.errors;
  }
  const fields = headerFields(header);
  const unidentified =
    supplierId === undefined && fields.reference === undefined && created.length === 0 &&
    Object.keys(errors).length === 0;
  if (Object.keys(errors).length > 0 || unidentified) {
    return { ok: false, lineErrors: errors, unidentified };
  }
  const payload: CreatePurchaseOrder = { status: header.status };
  if (supplierId !== undefined) payload.supplierId = supplierId;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) (payload as Record<string, unknown>)[key] = value;
  }
  if (created.length > 0) payload.lines = created;
  return { ok: true, payload };
}

/** A saved purchase → the header the edit form starts from. */
export function headerDraftFrom(purchase: PurchaseOrder): PurchaseHeaderDraft {
  return {
    reference: purchase.reference ?? "",
    // A status a newer build wrote reads as ORDERED in the form; it is only sent if changed.
    status: (["DRAFT", "ORDERED", "CANCELLED"] as const).includes(
      purchase.status as PurchaseOrderStatus,
    )
      ? (purchase.status as PurchaseOrderStatus)
      : "ORDERED",
    currency: purchase.currency ?? "",
    orderDate: isoToDateInput(purchase.orderDate),
    expectedDate: isoToDateInput(purchase.expectedDate),
    invoiceDate: isoToDateInput(purchase.invoiceDate),
    invoiceNumbers: purchase.invoiceNumbers ?? "",
    company: purchase.company ?? "",
    deliveryLocationId: purchase.deliveryLocationId ?? "",
    notes: purchase.notes ?? "",
  };
}

/**
 * The edit form → `PATCH /purchase-orders/:id`: only the fields that changed, a cleared one as `null`.
 * `null` when nothing changed (no request needed). The status is changed from the detail page, not here,
 * so it is never part of this diff.
 */
export function toUpdatePurchase(
  header: PurchaseHeaderDraft,
  supplierId: string | null,
  original: PurchaseOrder,
): UpdatePurchaseOrder | null {
  const out: UpdatePurchaseOrder = {};
  const text = (key: keyof UpdatePurchaseOrder, value: string, before: string | null) => {
    const next = value.trim() || null;
    if (next !== (before ?? null)) (out as Record<string, unknown>)[key] = next;
  };
  const date = (key: keyof UpdatePurchaseOrder, value: string, before: string | null) => {
    if (value !== isoToDateInput(before)) {
      (out as Record<string, unknown>)[key] = dateInputToIso(value) ?? null;
    }
  };
  if (supplierId !== original.supplierId) out.supplierId = supplierId;
  text("reference", header.reference, original.reference);
  text("currency", header.currency, original.currency);
  date("orderDate", header.orderDate, original.orderDate);
  date("expectedDate", header.expectedDate, original.expectedDate);
  date("invoiceDate", header.invoiceDate, original.invoiceDate);
  text("invoiceNumbers", header.invoiceNumbers, original.invoiceNumbers);
  text("company", header.company, original.company);
  if ((header.deliveryLocationId || null) !== original.deliveryLocationId) {
    out.deliveryLocationId = header.deliveryLocationId || null;
  }
  text("notes", header.notes, original.notes);
  return Object.keys(out).length > 0 ? out : null;
}

/** A saved line → the draft the line dialog starts from. */
export function lineDraftFrom(line: PurchaseOrderLine, locale: string): LineDraft {
  return {
    key: line.id,
    kind: line.kind,
    description: line.description,
    manufacturerText: line.manufacturerText ?? "",
    modelText: line.modelText ?? "",
    assetModelId: line.assetModelId ?? "",
    consumableId: line.consumableId ?? "",
    quantity: String(line.quantity),
    unitPrice: line.unitPrice == null ? "" : formatMoney(line.unitPrice, locale),
    warrantyMonths: line.warrantyMonths == null ? "" : String(line.warrantyMonths),
  };
}

/**
 * The line dialog → `PATCH .../lines/:lineId`: only what changed, a cleared field as `null`; `null` when
 * nothing changed. The brand, model and warranty are edited only on an `ASSET` line: on any other kind
 * they are hidden and left as stored, never cleared. The consumable is edited only on a `CONSUMABLE` line
 * (the API clears it when the line changes away from that kind). A line of a kind this build does not
 * know keeps it.
 */
export function toUpdateLine(
  draft: LineDraft,
  original: PurchaseOrderLine,
  locale: string,
):
  | { ok: true; payload: UpdatePurchaseOrderLine | null }
  | { ok: false; errors: LineErrors } {
  const parsed = parseLine(draft, locale);
  if (!parsed.ok) return parsed;
  const out: UpdatePurchaseOrderLine = {};
  if (draft.kind !== original.kind && isWritableKind(draft.kind)) out.kind = draft.kind;
  if (parsed.description !== original.description) out.description = parsed.description;
  if (parsed.quantity !== original.quantity) out.quantity = parsed.quantity;
  if (parsed.unitPrice !== (original.unitPrice ?? null)) out.unitPrice = parsed.unitPrice;
  if (draft.kind === "ASSET") {
    const manufacturer = draft.manufacturerText.trim() || null;
    const model = draft.modelText.trim() || null;
    const assetModelId = draft.assetModelId || null;
    if (manufacturer !== original.manufacturerText) out.manufacturerText = manufacturer;
    if (model !== original.modelText) out.modelText = model;
    if (assetModelId !== original.assetModelId) out.assetModelId = assetModelId;
    if (parsed.warrantyMonths !== original.warrantyMonths) out.warrantyMonths = parsed.warrantyMonths;
  }
  if (draft.kind === "CONSUMABLE") {
    const consumableId = draft.consumableId || null;
    if (consumableId !== (original.consumableId ?? null)) out.consumableId = consumableId;
  }
  return { ok: true, payload: Object.keys(out).length > 0 ? out : null };
}
