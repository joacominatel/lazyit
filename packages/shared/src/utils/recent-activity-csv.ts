// The header `GET /dashboard/activity/export` pins (ADR-0103).

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
