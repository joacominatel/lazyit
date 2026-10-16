// The importer's column contract (ADR-0069), pinned by `GET /assets/export` (ADR-0103): append only.

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
