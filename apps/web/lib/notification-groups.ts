import type {
  Notification,
  NotificationGroup,
  NotificationType,
} from "@lazyit/shared";

// The badge never grows past three characters; the exact count lives in the aria-label.
export function formatBadgeCount(unread: number): string {
  return unread > 99 ? "99+" : String(unread);
}

export function dayInZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function previousDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10);
}

// Judged in the zone the API grouped in, so a group's "today" matches its day window.
export function relativeDayKey(
  day: string,
  now: Date,
  timeZone: string,
): "today" | "yesterday" | null {
  const today = dayInZone(now, timeZone);
  if (day === today) return "today";
  if (day === previousDay(today)) return "yesterday";
  return null;
}

export function singleNotification(
  group: NotificationGroup,
): Notification | null {
  return group.count === 1 ? (group.latest[0] ?? null) : null;
}

export function groupKey(group: Pick<NotificationGroup, "type" | "day">): string {
  return `${group.type}|${group.day}`;
}

// A group that gains an item jumps to the top between page fetches and would otherwise show twice.
export function flattenGroupPages(
  pages: ReadonlyArray<{ items: readonly NotificationGroup[] }>,
): NotificationGroup[] {
  const seen = new Set<string>();
  const out: NotificationGroup[] = [];
  for (const page of pages) {
    for (const group of page.items) {
      const key = groupKey(group);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(group);
    }
  }
  return out;
}

// next-intl reads dots as nesting, so `workflow.manual_task` is keyed `workflow_manual_task`.
export function groupSummaryKey(type: NotificationType): string {
  return `groupSummary.${type.replace(/\./g, "_")}`;
}

export function newestLatestAt(
  groups: readonly NotificationGroup[],
): string | undefined {
  let newest: string | undefined;
  for (const g of groups) {
    if (newest === undefined || Date.parse(g.latestAt) > Date.parse(newest)) {
      newest = g.latestAt;
    }
  }
  return newest;
}
