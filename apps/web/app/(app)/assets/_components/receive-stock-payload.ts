/**
 * Pure form-to-wire glue for the bulk-receive (stock intake) dialog — ADR-0089 Part A.
 *
 * Extracted from the dialog (issue #1229) so the mapping can be unit-tested without mounting React:
 * the dialog now opens a NESTED "create model" dialog mid-flow, and the contract that must never
 * regress is that the model chosen last lands in `modelId` while every other typed field survives
 * untouched. Nothing here talks to the network or to React.
 *
 * The empty-field rules encoded here are load-bearing: blank optional id/date fields are OMITTED
 * (an empty string fails `cuid()` / `datetime()` in `ReceiveAssetsSchema`), money is converted from
 * the MAJOR units the operator types to the minor units the wire carries (#954), and `serials` is
 * absent — not `[]` — when nothing was pasted. `ReceiveAssetsSchema` remains the single validator.
 */

import { majorToMinor } from "@/lib/utils/money";
import type { AssetStatus } from "@lazyit/shared";

/**
 * The dialog's raw local state. Everything is a string because it comes straight from inputs; the
 * serials textarea is one serial per line and `purchaseCost` is major units as typed.
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
 * - `purchaseCost` goes through `majorToMinor` (blank → `null`, the schema's "not set").
 * - `serials` is omitted entirely when the paste is empty.
 */
export function buildReceivePayload(
  values: ReceiveStockFormValues,
): Record<string, unknown> {
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
    purchaseCost: majorToMinor(values.purchaseCost),
    ...(notes ? { notes } : {}),
    ...(serialLines.length > 0 ? { serials: serialLines } : {}),
  };
}
