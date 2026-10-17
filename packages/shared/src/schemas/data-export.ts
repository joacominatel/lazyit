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
