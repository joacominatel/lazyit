import type { AssetListItem } from "../schemas/asset-list";
import { escapeCsvCell } from "./recent-activity-csv";

/**
 * The ONE source of truth for the asset-inventory CSV shape (issue #872): column order + cell escaping,
 * for the Assets screen's filtered export. Clones the audit-log/activity export mold — the API "export
 * all (filtered)" stream (apps/api `AssetsService.streamInventoryCsvRows`) serializes each row through
 * this exact function, so the file can never drift from the on-screen list.
 *
 * RFC-4180 escaping + the spreadsheet formula-injection guard are REUSED from `recent-activity-csv.ts`
 * ({@link escapeCsvCell}) — NOT reimplemented — so a hostile asset/company/owner name (`=cmd|…`) is
 * neutralized identically to the other exports.
 *
 * The row is fed the LEAN list shape ({@link AssetListItem}) — the same trimmed projection the list
 * renders — so the export shows exactly what the operator filtered. The `specs` jsonb is intentionally
 * OMITTED in v1 (it is already absent from the lean list shape): per-unit spec keys vary across the
 * estate and fight a static, flat header. A dynamic per-spec-key export is a deferred follow-up.
 *
 * `owners` is the live active-assignment owners joined `First Last` with `'; '`, EXCLUDING soft-deleted
 * (departed) owners — a person who has left the org is not a current holder of the asset.
 *
 * Purchases (ADR-0099 §13, #1473): `purchaseCost` (a plain decimal in major units, see
 * {@link moneyToCsvAmount}) and `purchaseCurrency` (the label as typed) are always present — they are the
 * asset's own fields, readable under `asset:read`. The provenance columns `supplier`, `purchaseReference`
 * and `invoiceNumbers` are appended ONLY when the caller holds `purchaseOrder:read` (`includePurchase`):
 * without it the columns are absent, not blank, so an empty cell always means "no value" (CEO decision D-A).
 * New columns are appended at the END, so a reader that maps the earlier columns by position keeps working.
 */

/** The fields of the lean list row the inventory CSV reads (a subset of {@link AssetListItem}). */
export type AssetInventoryCsvItem = Pick<
  AssetListItem,
  | "name"
  | "assetTag"
  | "serial"
  | "status"
  | "company"
  | "purchaseDate"
  | "warrantyEnd"
  | "notes"
  | "createdAt"
  | "updatedAt"
  | "model"
  | "location"
  | "activeAssignments"
> & {
  /** Minor units; absent or `null` = unknown (an item built before #1473 reads as an empty cell). */
  purchaseCost?: number | null;
  purchaseCurrency?: string | null;
  /** The linked purchase's provenance — read only when the export includes the purchase columns. */
  purchase?: {
    supplierName: string | null;
    reference: string | null;
    invoiceNumbers: string | null;
  } | null;
};

/** Options of the inventory CSV. `includePurchase` = the caller holds `purchaseOrder:read`. */
export interface AssetInventoryCsvOptions {
  includePurchase?: boolean;
}

/** CSV columns, in output order. Flat + static — one column per field the list surfaces. */
export const ASSET_INVENTORY_CSV_COLUMNS = [
  "name",
  "assetTag",
  "serial",
  "status",
  "category",
  "manufacturer",
  "model",
  "location",
  "company",
  "purchaseDate",
  "warrantyEnd",
  "owners",
  "notes",
  "createdAt",
  "updatedAt",
  "purchaseCost",
  "purchaseCurrency",
] as const;

/** The provenance columns, appended only for a caller holding `purchaseOrder:read` (ADR-0099 §8). */
export const ASSET_INVENTORY_CSV_PURCHASE_COLUMNS = [
  "supplier",
  "purchaseReference",
  "invoiceNumbers",
] as const;

/** The CSV header line (the column names joined by commas), without the provenance columns. */
export const ASSET_INVENTORY_CSV_HEADER = ASSET_INVENTORY_CSV_COLUMNS.join(",");

/** The header line for the given options. */
export function assetInventoryCsvHeader(options: AssetInventoryCsvOptions = {}): string {
  return options.includePurchase
    ? [...ASSET_INVENTORY_CSV_COLUMNS, ...ASSET_INVENTORY_CSV_PURCHASE_COLUMNS].join(",")
    : ASSET_INVENTORY_CSV_HEADER;
}

/**
 * A money amount (integer minor units, ADR-0100) as a spreadsheet-friendly CSV cell: major units with a dot
 * decimal separator and no grouping — `150000` → `1500`, `150050` → `1500.50`. A whole amount is not padded
 * (ADR-0100 §5); a fraction keeps the stored two decimals. `null` / absent → empty.
 */
export function moneyToCsvAmount(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return "";
  const major = Math.trunc(minor / 100);
  const cents = minor % 100;
  return cents === 0 ? String(major) : `${major}.${String(cents).padStart(2, "0")}`;
}

/** Live owners joined "First Last" with "; ", EXCLUDING soft-deleted (departed) owners. */
function ownersCell(item: AssetInventoryCsvItem): string {
  return item.activeAssignments
    .filter((assignment) => assignment.user.deletedAt === null)
    .map((assignment) => `${assignment.user.firstName} ${assignment.user.lastName}`)
    .join("; ");
}

/** Serialize one lean asset row to an escaped CSV line (no trailing newline). */
export function assetInventoryCsvRow(
  item: AssetInventoryCsvItem,
  options: AssetInventoryCsvOptions = {},
): string {
  const cells = [
    item.name,
    item.assetTag ?? "",
    item.serial ?? "",
    item.status,
    // Category lives on the model, not the asset (see the domain model).
    item.model?.category?.name ?? "",
    item.model?.manufacturer ?? "",
    item.model?.name ?? "",
    item.location?.name ?? "",
    item.company ?? "",
    item.purchaseDate ?? "",
    item.warrantyEnd ?? "",
    ownersCell(item),
    item.notes ?? "",
    item.createdAt,
    item.updatedAt,
    moneyToCsvAmount(item.purchaseCost),
    item.purchaseCurrency ?? "",
  ];
  if (options.includePurchase) {
    cells.push(
      item.purchase?.supplierName ?? "",
      item.purchase?.reference ?? "",
      item.purchase?.invoiceNumbers ?? "",
    );
  }
  return cells.map((cell) => escapeCsvCell(String(cell))).join(",");
}

/** Serialize the given rows to a full CSV document (header + one line per row). */
export function assetInventoryToCsv(
  items: AssetInventoryCsvItem[],
  options: AssetInventoryCsvOptions = {},
): string {
  return [
    assetInventoryCsvHeader(options),
    ...items.map((item) => assetInventoryCsvRow(item, options)),
  ].join("\n");
}
