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
