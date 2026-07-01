import {
  type AssetFilters,
  downloadAssetInventoryExport,
} from "@/lib/api/endpoints/assets";

/**
 * Asset-inventory CSV export (issue #872) — mirrors `reports/audit/_components/audit-csv.ts`.
 *
 * {@link downloadAssetsExport} streams the WHOLE filtered range from the API's `GET /assets/export` and
 * triggers a browser download. The column order + RFC-4180 escaping + spreadsheet formula-injection
 * guard live ONCE in `@lazyit/shared` (`asset-inventory-csv.ts`), applied server-side, so the file can
 * never drift from the on-screen list. Only the streamed "export all filtered" scope is exposed here
 * (there is no client-side "export visible page" button on the Assets screen).
 */

/** Default download name — `lazyit-assets-YYYY-MM-DD.csv`, matching the server's Content-Disposition. */
function defaultFilename(): string {
  return `lazyit-assets-${new Date().toISOString().slice(0, 10)}.csv`;
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
 * Download the ENTIRE filtered inventory by streaming `GET /assets/export` with the current filters,
 * then triggering a browser download. Throws on a failed request so the caller can surface an error.
 */
export async function downloadAssetsExport(
  filters: AssetFilters,
  filename = defaultFilename(),
): Promise<void> {
  const blob = await downloadAssetInventoryExport(filters);
  triggerBlobDownload(blob, filename);
}
