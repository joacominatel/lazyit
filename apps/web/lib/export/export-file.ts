import { DATA_EXPORT_ROW_CAP } from "@lazyit/shared";
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

/** The same name the server's Content-Disposition carries. */
export function exportFileName(stem: string, now: Date = new Date()): string {
  return `lazyit-${stem}-${now.toISOString().slice(0, 10)}.csv`;
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
): Promise<void> {
  const blob = await apiFetchBlob(exportUrl(path, params));
  saveBlob(blob, exportFileName(stem));
}
