/**
 * Recency groups of the conversation list (frontend.md §5.2): Today · Yesterday · Previous 7 days · Older,
 * by calendar day in the instance time zone (`DEFAULT_TIME_ZONE`), so the server render and the client
 * agree.
 */

export const HISTORY_GROUPS = ["today", "yesterday", "week", "older"] as const;
export type HistoryGroup = (typeof HISTORY_GROUPS)[number];

/** The calendar day of `date` in `timeZone`, as a day number (days since the epoch). */
function dayNumber(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Math.floor(Date.UTC(get("year"), get("month") - 1, get("day")) / 86_400_000);
}

export function historyGroupOf(updatedAt: string, now: Date, timeZone: string): HistoryGroup {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return "older";
  const diff = dayNumber(now, timeZone) - dayNumber(date, timeZone);
  if (diff <= 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff < 7) return "week";
  return "older";
}

/** Groups items (already newest first) in the fixed group order, dropping empty groups. */
export function groupByRecency<T extends { updatedAt: string }>(
  items: readonly T[],
  now: Date,
  timeZone: string,
): { group: HistoryGroup; items: T[] }[] {
  const buckets = new Map<HistoryGroup, T[]>();
  for (const item of items) {
    const group = historyGroupOf(item.updatedAt, now, timeZone);
    const bucket = buckets.get(group) ?? [];
    bucket.push(item);
    buckets.set(group, bucket);
  }
  return HISTORY_GROUPS.filter((g) => buckets.has(g)).map((group) => ({
    group,
    items: buckets.get(group)!,
  }));
}
