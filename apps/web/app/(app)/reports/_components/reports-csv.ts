import { recentActivityToCsv, type RecentActivityItem } from "@lazyit/shared";
import {
  downloadDashboardActivityExport,
  type DashboardActivityFilters,
} from "@/lib/api/endpoints/dashboard";

/**
 * Reports CSV export — two scopes:
 *
 *  - {@link downloadCsv} exports exactly what's ON SCREEN (the current server-filtered page/window),
 *    built client-side. Honest, zero-network, but only the visible rows.
 *  - {@link downloadActivityExport} (issue #840) downloads the WHOLE filtered range from the API's
 *    streaming `GET /dashboard/activity/export`, so the file is the complete filtered history, not just
 *    the page.
 *
 * Both write identical CSV: the column order + RFC-4180 escaping + spreadsheet formula-injection guard
 * live ONCE in `@lazyit/shared` ({@link recentActivityToCsv}), shared with the server-side exporter, so
 * the two paths can never drift on the security-relevant escaping.
 */

/** Default download filename, dated so repeated exports don't collide. */
function defaultFilename(): string {
  return `reports-${new Date().toISOString().slice(0, 10)}.csv`;
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

/**
 * Download the given (currently-visible) rows as a CSV file, built client-side. Exports exactly the
 * rows passed in — the active filters AND the current page.
 */
export function downloadCsv(
  items: RecentActivityItem[],
  filename = defaultFilename(),
): void {
  const csv = recentActivityToCsv(items);
  triggerBlobDownload(new Blob([csv], { type: "text/csv;charset=utf-8;" }), filename);
}

/**
 * Download the ENTIRE filtered activity range (issue #840) by streaming `GET
 * /dashboard/activity/export` with the current filters, then triggering a browser download. The server
 * applies the identical escaping/injection guard. Throws on a failed request so the caller can surface
 * an error.
 */
export async function downloadActivityExport(
  filters: DashboardActivityFilters,
  filename = defaultFilename(),
): Promise<void> {
  const blob = await downloadDashboardActivityExport(filters);
  triggerBlobDownload(blob, filename);
}
