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
>;

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
] as const;

/** The CSV header line (the column names joined by commas). */
export const ASSET_INVENTORY_CSV_HEADER = ASSET_INVENTORY_CSV_COLUMNS.join(",");

/** Live owners joined "First Last" with "; ", EXCLUDING soft-deleted (departed) owners. */
function ownersCell(item: AssetInventoryCsvItem): string {
  return item.activeAssignments
    .filter((assignment) => assignment.user.deletedAt === null)
    .map((assignment) => `${assignment.user.firstName} ${assignment.user.lastName}`)
    .join("; ");
}

/** Serialize one lean asset row to an escaped CSV line (no trailing newline). */
export function assetInventoryCsvRow(item: AssetInventoryCsvItem): string {
  return [
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
  ]
    .map((cell) => escapeCsvCell(String(cell)))
    .join(",");
}

/** Serialize the given rows to a full CSV document (header + one line per row). */
export function assetInventoryToCsv(items: AssetInventoryCsvItem[]): string {
  return [
    ASSET_INVENTORY_CSV_HEADER,
    ...items.map(assetInventoryCsvRow),
  ].join("\n");
}
