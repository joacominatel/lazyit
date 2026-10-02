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
  | { kind: "deleted" }
  | { kind: "restored" }
  | { kind: "other"; eventType: string };

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

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
export const ID_FIELDS = new Set(["supplierId", "deliveryLocationId", "assetModelId"]);
