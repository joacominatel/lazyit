import type { RecentActivityItem } from "../schemas/recent-activity";

/**
 * The ONE source of truth for the recent-activity CSV shape (issue #840): column order, RFC-4180 cell
 * escaping and the spreadsheet formula-injection guard. Both sides export identically — the browser
 * "export visible page" path (apps/web `reports-csv.ts`) and the API "export all (filtered)" stream
 * (apps/api `DashboardService.streamActivityCsvRows`). Keeping the rules here means the security
 * guards can never drift between the two exporters.
 *
 * Pure + framework-agnostic (no DOM, no Node) → belongs in `@lazyit/shared` per the shared-package
 * contract; unit-testable in isolation.
 */

/** CSV columns, in output order. Mirrors the Reports table (when/action/entity/actor/summary). */
export const RECENT_ACTIVITY_CSV_COLUMNS = [
  "occurredAt",
  "action",
  "entityType",
  "entityId",
  "actorName",
  "summary",
] as const;

/** The CSV header line (the column names joined by commas). */
export const RECENT_ACTIVITY_CSV_HEADER = RECENT_ACTIVITY_CSV_COLUMNS.join(",");

/**
 * RFC-4180 cell escaping + spreadsheet formula-injection guard. A leading `=`/`+`/`-`/`@` (or a
 * control char) is defused with a single quote so a crafted `actorName`/`summary` can't execute as a
 * formula when the export is opened in Excel/Sheets; then quote-wrap (doubling embedded quotes) when
 * the cell holds a comma/quote/newline. This is a MANDATORY output-boundary guard — do not skip it.
 */
export function escapeCsvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[",\n\r]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

/** Serialize one activity row to an escaped CSV line (no trailing newline). */
export function recentActivityCsvRow(
  item: Pick<
    RecentActivityItem,
    "occurredAt" | "action" | "entityType" | "entityId" | "actorName" | "summary"
  >,
): string {
  return [
    item.occurredAt,
    item.action,
    item.entityType,
    item.entityId,
    item.actorName ?? "",
    item.summary,
  ]
    .map((cell) => escapeCsvCell(String(cell)))
    .join(",");
}

/** Serialize the given rows to a full CSV document (header + one line per row). */
export function recentActivityToCsv(
  items: Parameters<typeof recentActivityCsvRow>[0][],
): string {
  return [RECENT_ACTIVITY_CSV_HEADER, ...items.map(recentActivityCsvRow)].join(
    "\n",
  );
}
