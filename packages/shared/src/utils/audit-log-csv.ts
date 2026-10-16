// The header `GET /audit/logs/export` pins (ADR-0103). INV-10: metadata columns only, never a secret value.

/** CSV columns, in output order. Covers every source; a source leaves its irrelevant columns empty. */
export const AUDIT_LOG_CSV_COLUMNS = [
  "occurredAt",
  "source",
  "action",
  "actorName",
  "serviceAccountName",
  "vaultName",
  "itemLabel",
  "targetUserName",
  "targetServiceAccountName",
  "role",
  "permission",
  "detail",
] as const;

/** The CSV header line (the column names joined by commas). */
export const AUDIT_LOG_CSV_HEADER = AUDIT_LOG_CSV_COLUMNS.join(",");
