/**
 * The purchase activity log, read tolerantly (ADR-0099, purchase-order-event entity note). `eventType` is
 * TEXT and `payload` unvalidated jsonb: a type a newer build appends, or a payload missing a field, reads
 * as a generic entry — never "undefined" on screen and never a crash. Pure; the timeline translates it.
 */

import type { PurchaseOrderEvent } from "@lazyit/shared";

/** One recorded field change. Values are as logged: text, a number (money in minor units), or null. */
export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
  /** Logged by name only (long free text such as notes). */
  nameOnly: boolean;
}

export type PurchaseEventView =
  | { kind: "created"; lineCount: number | null }
  | { kind: "statusChanged"; from: string | null; to: string | null }
  | { kind: "updated"; changes: FieldChange[]; currency: string | null }
  | {
      kind: "lineAdded";
      description: string | null;
      quantity: number | null;
      unitPrice: number | null;
      currency: string | null;
    }
  | { kind: "lineUpdated"; lineId: string | null; changes: FieldChange[]; currency: string | null }
  | { kind: "lineRemoved"; lineId: string | null; description: string | null }
  // Receiving, linking, cancelling and documents (#1473). Counts read from the logged ids when no count was.
  | { kind: "unitsReceived"; lineId: string | null; quantity: number | null; failed: number; over: boolean }
  | { kind: "unitsCancelled"; lineId: string | null; quantity: number | null; reason: string | null }
  | { kind: "assetsLinked"; lineId: string | null; count: number | null; moved: boolean; over: boolean }
  | { kind: "assetsUnlinked"; lineId: string | null; count: number | null; movedToPurchaseOrderId: string | null }
  | { kind: "documentAdded"; name: string | null; label: string | null }
  | { kind: "documentRemoved"; name: string | null; label: string | null }
  // Consumable lines and document type labels (#1476).
  | { kind: "stockReceived"; lineId: string | null; quantity: number | null; over: boolean }
  | { kind: "documentUpdated"; name: string | null; from: string | null; to: string | null }
  | { kind: "deleted" }
  | { kind: "restored" }
  | { kind: "other"; eventType: string };

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
/** The length of a logged id list; `null` when the payload has none. */
const count = (value: unknown): number | null => (Array.isArray(value) ? value.length : null);

/** `{ field: { from, to } | { changed: true } }` → a list, in the order logged; anything else is skipped. */
export function parseChanges(value: unknown): FieldChange[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const out: FieldChange[] = [];
  for (const [field, change] of Object.entries(value as Record<string, unknown>)) {
    if (change === null || typeof change !== "object") continue;
    const c = change as Record<string, unknown>;
    if (c.changed === true) out.push({ field, from: null, to: null, nameOnly: true });
    else if ("from" in c || "to" in c) out.push({ field, from: c.from ?? null, to: c.to ?? null, nameOnly: false });
  }
  return out;
}

/**
 * Logged amounts are printed with the currency label the EVENT recorded, when it recorded one — never with
 * the purchase's current label, which may have changed since. Without one, the amount prints bare.
 */
export function describePurchaseEvent(event: Pick<PurchaseOrderEvent, "eventType" | "payload">): PurchaseEventView {
  const p = event.payload ?? {};
  const currency = str(p.currency);
  switch (event.eventType) {
    case "CREATED":
      return { kind: "created", lineCount: num(p.lineCount) };
    case "STATUS_CHANGED":
      return { kind: "statusChanged", from: str(p.from), to: str(p.to) };
    case "UPDATED":
      return { kind: "updated", changes: parseChanges(p.changes), currency };
    case "LINE_ADDED":
      return {
        kind: "lineAdded",
        description: str(p.description),
        quantity: num(p.quantity),
        unitPrice: num(p.unitPrice),
        currency,
      };
    case "LINE_UPDATED":
      return { kind: "lineUpdated", lineId: str(p.lineId), changes: parseChanges(p.changes), currency };
    case "LINE_REMOVED":
      return { kind: "lineRemoved", lineId: str(p.lineId), description: str(p.description) };
    case "UNITS_RECEIVED":
      return {
        kind: "unitsReceived",
        lineId: str(p.lineId),
        quantity: num(p.quantity) ?? count(p.assetIds),
        failed: num(p.failed) ?? 0,
        over: p.overReceived === true,
      };
    case "UNITS_CANCELLED":
      return { kind: "unitsCancelled", lineId: str(p.lineId), quantity: num(p.quantity), reason: str(p.reason) };
    case "ASSET_LINKED":
      return {
        kind: "assetsLinked",
        lineId: str(p.lineId),
        count: count(p.assetIds),
        // The API logs the moved assets as a list ({ assetId, from… } each); a boolean reads too.
        moved: Array.isArray(p.moved) ? p.moved.length > 0 : p.moved === true,
        over: p.overReceived === true,
      };
    case "ASSET_UNLINKED":
      return {
        kind: "assetsUnlinked",
        lineId: str(p.lineId),
        count: count(p.assetIds),
        movedToPurchaseOrderId: str(p.movedToPurchaseOrderId),
      };
    case "DOCUMENT_ADDED":
      return { kind: "documentAdded", name: str(p.originalName), label: str(p.label) };
    case "DOCUMENT_REMOVED":
      return { kind: "documentRemoved", name: str(p.originalName), label: str(p.label) };
    case "STOCK_RECEIVED":
      return {
        kind: "stockReceived",
        lineId: str(p.lineId),
        quantity: num(p.quantity),
        over: p.overReceived === true,
      };
    case "DOCUMENT_UPDATED": {
      const label = p.label !== null && typeof p.label === "object" ? (p.label as Record<string, unknown>) : {};
      return { kind: "documentUpdated", name: str(p.originalName), from: str(label.from), to: str(label.to) };
    }
    case "DELETED":
      return { kind: "deleted" };
    case "RESTORED":
      return { kind: "restored" };
    default:
      return { kind: "other", eventType: event.eventType };
  }
}

/** Fields whose logged values are money (minor units) — printed with the purchase's currency label. */
export const MONEY_FIELDS = new Set(["unitPrice"]);
/** Fields whose logged values are ISO dates. */
export const DATE_FIELDS = new Set(["orderDate", "expectedDate", "invoiceDate"]);
/** Fields whose logged values are ids — shown by name only ("changed"), never as a raw id. */
export const ID_FIELDS = new Set(["supplierId", "deliveryLocationId", "assetModelId", "consumableId"]);
