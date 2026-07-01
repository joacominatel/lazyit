import type { AuditLogItem } from "../schemas/audit-log-query";
import { escapeCsvCell } from "./recent-activity-csv";

/**
 * The ONE source of truth for the audit-log CSV shape (issue #871): column order + cell escaping, for
 * the three security audit logs' read/export surface. Both exporters serialize identically — the
 * browser "export visible" path (apps/web `audit-csv.ts`) and the API "export all (filtered)" stream
 * (apps/api `AuditService.streamLogsCsvRows`) — so the security guard can never drift between them.
 *
 * RFC-4180 escaping + the spreadsheet formula-injection guard are REUSED from `recent-activity-csv.ts`
 * ({@link escapeCsvCell}) — NOT reimplemented — so a hostile actor/vault/item name (`=cmd|…`) is
 * neutralized identically to the activity export.
 *
 * INV-10: the columns are METADATA ONLY (names/labels/roles/permissions/action). There is no value
 * column — the secret's plaintext/ciphertext is never resolved, so it can never appear in the CSV. A
 * dangling soft-ref already degraded to its raw id upstream (in the resolved *Name field).
 *
 * The header is UNIFIED across sources (each export is source-scoped, so columns irrelevant to that
 * source are simply empty). ponytail: one flat wide header beats three per-source headers — the
 * ceiling is a slightly noisier file (empty columns) for a permission-only export.
 */

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

/** Serialize one resolved audit-log row to an escaped CSV line (no trailing newline). */
export function auditLogCsvRow(item: AuditLogItem): string {
  return [
    item.occurredAt,
    item.source,
    item.action,
    item.actorName ?? "",
    item.serviceAccountName ?? "",
    item.vaultName ?? "",
    item.itemLabel ?? "",
    item.targetUserName ?? "",
    item.targetServiceAccountName ?? "",
    item.role ?? "",
    item.permission ?? "",
    item.detail ?? "",
  ]
    .map((cell) => escapeCsvCell(String(cell)))
    .join(",");
}

/** Serialize the given rows to a full CSV document (header + one line per row). */
export function auditLogToCsv(items: AuditLogItem[]): string {
  return [AUDIT_LOG_CSV_HEADER, ...items.map(auditLogCsvRow)].join("\n");
}
