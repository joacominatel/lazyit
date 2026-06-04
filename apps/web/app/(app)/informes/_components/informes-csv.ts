import type { RecentActivityItem } from "@lazyit/shared";

/**
 * Build a CSV string for the currently-visible (client-filtered) Reports rows, and trigger a
 * download. Honest scope: this exports exactly what's on screen — the filtered window — never the
 * whole server-side history (the filters run client-side over the loaded page in v1). Columns match
 * the table: occurredAt, action, entityType, entityId, actorName, summary.
 *
 * Pure-ish: {@link toCsv} is a pure function (unit-testable); {@link downloadCsv} wraps it with the
 * Blob + anchor side-effect. No new dependency — a small, escaped CSV writer is enough here.
 */

const COLUMNS = [
  "occurredAt",
  "action",
  "entityType",
  "entityId",
  "actorName",
  "summary",
] as const;

/** RFC-4180 cell escaping: wrap in quotes and double any embedded quote when needed. */
function escapeCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Serialize the given rows to a CSV string (header + one line per row). */
export function toCsv(items: RecentActivityItem[]): string {
  const header = COLUMNS.join(",");
  const lines = items.map((item) =>
    [
      item.occurredAt,
      item.action,
      item.entityType,
      item.entityId,
      item.actorName ?? "",
      item.summary,
    ]
      .map((cell) => escapeCell(String(cell)))
      .join(","),
  );
  return [header, ...lines].join("\n");
}

/**
 * Download the given rows as a CSV file. The filename carries the local date so repeated exports
 * don't collide. No-op safely on the server (guards `document`).
 */
export function downloadCsv(
  items: RecentActivityItem[],
  filename = `informes-${new Date().toISOString().slice(0, 10)}.csv`,
): void {
  if (typeof document === "undefined") return;
  const csv = toCsv(items);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
