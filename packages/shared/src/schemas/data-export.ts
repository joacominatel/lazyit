import { z } from "zod";

// Stored as text on DataExportLog, not a Postgres enum: a new resource needs no migration (ADR-0103).
export const DATA_EXPORT_RESOURCES = [
  "ASSETS",
  "ACTIVITY",
  "AUDIT",
  "USERS",
  "ACCESS_GRANTS",
  "CONSUMABLES",
  "PURCHASE_ORDERS",
  "APPLICATIONS",
  "LOCATIONS",
  "SUPPLIERS",
  "PENDING_UNITS",
  "ACCESS_REQUESTS",
  "INFRA_NODES",
  "CONSUMABLE_MOVEMENTS",
  "CONSUMABLE_DELIVERIES",
  "ARTICLES",
] as const;
export const DataExportResourceSchema = z.enum(DATA_EXPORT_RESOURCES);
export type DataExportResource = z.infer<typeof DataExportResourceSchema>;

/** Above this many matching rows an export is refused (422), never truncated. */
export const DATA_EXPORT_ROW_CAP = 100_000;

/** The file formats of a server export (`?format=`); omitted means `csv` (ADR-0103 §11). */
export const DATA_EXPORT_FORMATS = ["csv", "xlsx"] as const;
export const DataExportFormatSchema = z.enum(DATA_EXPORT_FORMATS);
export type DataExportFormat = z.infer<typeof DataExportFormatSchema>;

/** The resources whose export route also serves `format=xlsx`; every other export is CSV only. */
export const DATA_EXPORT_XLSX_RESOURCES = [
  "ASSETS",
  "PURCHASE_ORDERS",
] as const satisfies readonly DataExportResource[];
