import type { RecentActivityItem } from "@lazyit/shared";

/**
 * Day-bucketing for the unified recent-activity stream — extracted from the dashboard's
 * RecentActivityPanel so it can be SHARED by the Reports/Informes timeline without copy-paste.
 * Pure functions only (no React); the caller snapshots `now` once (`useState(() => Date.now())`)
 * so the dividers stay pure across renders.
 */

/**
 * Stable day-bucket key — drives React keys/grouping AND selects the localized divider label at
 * the render site (`shared.activity.dateGroup.*`). NOT a display string, so it never gets
 * translated in this pure util (issue #204).
 */
export type ActivityGroupKey = "today" | "yesterday" | "earlier";

/** A day bucket of activity rows, carrying each row's GLOBAL index for the capped stagger. */
export interface ActivityGroup {
  /** Stable key — use as the React key and to resolve the localized label at the render site. */
  key: ActivityGroupKey;
  items: { item: RecentActivityItem; index: number }[];
}

/** Local Y-M-D key for a timestamp, so "same day" is judged in the viewer's local zone. */
function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * Bucket a newest-first activity stream into Today / Yesterday / Earlier, comparing each
 * row's local calendar day against the snapshotted `now`. Single pass (the stream is already
 * ordered), so the returned groups stay newest-first and carry each row's global index — the
 * index drives the capped staggered settle in the timeline row.
 */
export function groupByDay(
  items: RecentActivityItem[],
  now: number,
): ActivityGroup[] {
  const today = dayKey(new Date(now));
  const yesterday = dayKey(new Date(now - 24 * 60 * 60 * 1000));
  const order: ActivityGroupKey[] = ["today", "yesterday", "earlier"];
  const buckets = new Map<
    ActivityGroupKey,
    { item: RecentActivityItem; index: number }[]
  >();
  items.forEach((item, index) => {
    const day = dayKey(new Date(item.occurredAt));
    const key: ActivityGroupKey =
      day === today ? "today" : day === yesterday ? "yesterday" : "earlier";
    const bucket = buckets.get(key);
    if (bucket) bucket.push({ item, index });
    else buckets.set(key, [{ item, index }]);
  });
  return order
    .filter((key) => buckets.has(key))
    .map((key) => ({ key, items: buckets.get(key) ?? [] }));
}
