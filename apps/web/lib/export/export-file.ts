import {
  DATA_EXPORT_ROW_CAP,
  DATA_EXPORT_XLSX_RESOURCES,
  type DataExportFormat,
  type DataExportResource,
} from "@lazyit/shared";
import { ApiError, apiFetchBlob } from "@/lib/api/client";

export type ExportBlock = "empty" | "overCap";

/** `total` is the list's `Page.total` for the same filters; `undefined` while it loads. */
export function exportBlock(total: number | undefined): ExportBlock | null {
  if (total === undefined || total <= 0) return "empty";
  if (total > DATA_EXPORT_ROW_CAP) return "overCap";
  return null;
}

export type ExportErrorKind = "overCap" | "busy" | "forbidden";

/** The refusals of ADR-0103: 422 over the cap, 429 limiter, 403 list permission. */
export function exportErrorKind(error: unknown): ExportErrorKind | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 422) return "overCap";
  if (error.status === 429) return "busy";
  if (error.status === 403) return "forbidden";
  return null;
}

/** The extension and media type the server answers each format with (ADR-0103 §11). */
export const EXPORT_FILE_TYPES = {
  csv: { extension: "csv", mime: "text/csv; charset=utf-8" },
  xlsx: {
    extension: "xlsx",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
} as const satisfies Record<DataExportFormat, { extension: string; mime: string }>;

/**
 * The formats a list's export offers: CSV everywhere, plus XLSX on the routes that opted in
 * (`DATA_EXPORT_XLSX_RESOURCES`). A list that names no resource is CSV only.
 */
export function exportFormats(resource?: DataExportResource): readonly DataExportFormat[] {
  const xlsx: readonly DataExportResource[] = DATA_EXPORT_XLSX_RESOURCES;
  return resource && xlsx.includes(resource) ? ["csv", "xlsx"] : ["csv"];
}

/** The same name the server's Content-Disposition carries. */
export function exportFileName(
  stem: string,
  format: DataExportFormat = "csv",
  now: Date = new Date(),
): string {
  return `lazyit-${stem}-${now.toISOString().slice(0, 10)}.${EXPORT_FILE_TYPES[format].extension}`;
}

/**
 * The list's filter params plus `format`, never touching the caller's params. CSV sends no
 * `format` at all, so its request is the one it always was; XLSX appends `format=xlsx`.
 */
export function exportParams(params: URLSearchParams, format: DataExportFormat): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete("format");
  if (format !== "csv") next.append("format", format);
  return next;
}

/** The download typed as its format, so the saved file matches its extension whatever the proxy sent. */
export function exportBlob(blob: Blob, format: DataExportFormat): Blob {
  const { mime } = EXPORT_FILE_TYPES[format];
  return blob.type === mime ? blob : new Blob([blob], { type: mime });
}

export function exportUrl(path: string, params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function saveBlob(blob: Blob, filename: string): void {
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

// A Bearer-authenticated route cannot be a plain <a href>, so the file goes through a Blob.
export async function downloadExport(
  path: string,
  params: URLSearchParams,
  stem: string,
  format: DataExportFormat = "csv",
): Promise<void> {
  const blob = await apiFetchBlob(exportUrl(path, exportParams(params, format)));
  saveBlob(exportBlob(blob, format), exportFileName(stem, format));
}
