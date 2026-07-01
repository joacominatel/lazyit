import { type AuditLogItem, auditLogToCsv } from "@lazyit/shared";
import type { AuditLogSource } from "@lazyit/shared";
import {
  type AuditLogClientFilters,
  downloadAuditLogExport,
} from "@/lib/api/endpoints/audit";

/**
 * Audit-log CSV export — two scopes, mirroring `reports-csv.ts`:
 *
 *  - {@link downloadVisibleAuditCsv} exports exactly the rows ON SCREEN (the current server-filtered
 *    page), built client-side.
 *  - {@link downloadAuditExport} downloads the WHOLE filtered range from the API's streaming
 *    `GET /audit/logs/export`.
 *
 * Both write identical CSV: the column order + RFC-4180 escaping + spreadsheet formula-injection guard
 * live ONCE in `@lazyit/shared` ({@link auditLogToCsv}, reusing the recent-activity guard), shared with
 * the server exporter, so the two paths can never drift. INV-10: there is no value column — a secret's
 * plaintext/ciphertext can never appear.
 */

function defaultFilename(source: AuditLogSource): string {
  return `audit-${source}-${new Date().toISOString().slice(0, 10)}.csv`;
}

/** Trigger a browser download of a Blob. No-op safely on the server (guards `document`). */
function triggerBlobDownload(blob: Blob, filename: string): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/** Download the currently-visible rows as CSV, built client-side (active filters AND current page). */
export function downloadVisibleAuditCsv(
  source: AuditLogSource,
  items: AuditLogItem[],
  filename = defaultFilename(source),
): void {
  const csv = auditLogToCsv(items);
  triggerBlobDownload(
    new Blob([csv], { type: "text/csv;charset=utf-8;" }),
    filename,
  );
}

/**
 * Download the ENTIRE filtered range by streaming `GET /audit/logs/export` with the current filters,
 * then triggering a browser download. Throws on a failed request so the caller can surface an error.
 */
export async function downloadAuditExport(
  source: AuditLogSource,
  filters: AuditLogClientFilters,
  filename = defaultFilename(source),
): Promise<void> {
  const blob = await downloadAuditLogExport(source, filters);
  triggerBlobDownload(blob, filename);
}
