import { describe, expect, test } from "bun:test";
import {
  NOTIFICATION_TYPES,
  type Notification,
  type NotificationGroup,
} from "@lazyit/shared";
import { createTranslator } from "next-intl";
import en from "@/messages/en/notifications.json";
import es from "@/messages/es/notifications.json";
import {
  dayInZone,
  flattenGroupPages,
  formatBadgeCount,
  groupSummaryKey,
  newestLatestAt,
  relativeDayKey,
  singleNotification,
} from "./notification-groups";

const BUENOS_AIRES = "America/Argentina/Buenos_Aires";

type Translate = {
  (key: string, values: { count: number }): string;
  has: (key: string) => boolean;
};

function translator(locale: "en" | "es"): Translate {
  return createTranslator({
    locale,
    messages: { notifications: locale === "en" ? en : es },
    namespace: "notifications",
  } as Parameters<typeof createTranslator>[0]) as unknown as Translate;
}

function notification(id: string, createdAt: string): Notification {
  return {
    id,
    type: "critical_app_access",
    severity: "warning",
    title: id,
    summary: null,
    entityType: null,
    entityId: null,
    targetUserId: null,
    recipientUserId: null,
    metadata: null,
    createdAt,
    read: false,
  };
}

function group(
  overrides: Partial<NotificationGroup> = {},
): NotificationGroup {
  const latest = [notification("a", "2026-10-17T10:00:00.000Z")];
  return {
    type: "critical_app_access",
    day: "2026-10-17",
    count: 1,
    unread: 1,
    latestAt: latest[0].createdAt,
    latest,
    ...overrides,
  };
}

describe("formatBadgeCount", () => {
  test("shows the exact count up to 99", () => {
    expect(formatBadgeCount(1)).toBe("1");
    expect(formatBadgeCount(99)).toBe("99");
  });

  test("caps at 99+ above that, however large", () => {
    expect(formatBadgeCount(100)).toBe("99+");
    expect(formatBadgeCount(912)).toBe("99+");
  });
});

describe("dayInZone", () => {
  test("reads the calendar day in the zone, not in UTC", () => {
    const instant = new Date("2026-10-17T02:00:00.000Z");
    expect(dayInZone(instant, "UTC")).toBe("2026-10-17");
    expect(dayInZone(instant, BUENOS_AIRES)).toBe("2026-10-16");
  });
});

describe("relativeDayKey", () => {
  const now = new Date("2026-10-17T15:00:00.000Z");

  test("labels today and yesterday", () => {
    expect(relativeDayKey("2026-10-17", now, "UTC")).toBe("today");
    expect(relativeDayKey("2026-10-16", now, "UTC")).toBe("yesterday");
  });

  test("returns null for anything older", () => {
    expect(relativeDayKey("2026-10-15", now, "UTC")).toBeNull();
    expect(relativeDayKey("2025-10-17", now, "UTC")).toBeNull();
  });

  test("judges today in the instance zone", () => {
    // 01:00 UTC on the 17th is still the 16th in Buenos Aires (UTC-3).
    const lateEvening = new Date("2026-10-17T01:00:00.000Z");
    expect(relativeDayKey("2026-10-16", lateEvening, BUENOS_AIRES)).toBe("today");
    expect(relativeDayKey("2026-10-17", lateEvening, BUENOS_AIRES)).toBeNull();
  });

  test("crosses month and year boundaries", () => {
    expect(
      relativeDayKey("2026-09-30", new Date("2026-10-01T12:00:00Z"), "UTC"),
    ).toBe("yesterday");
    expect(
      relativeDayKey("2025-12-31", new Date("2026-01-01T12:00:00Z"), "UTC"),
    ).toBe("yesterday");
  });
});

describe("singleNotification", () => {
  test("a one-item group is that notification", () => {
    const g = group();
    expect(singleNotification(g)).toBe(g.latest[0]);
  });

  test("a larger group renders as a group", () => {
    const latest = [
      notification("a", "2026-10-17T10:00:00.000Z"),
      notification("b", "2026-10-17T09:00:00.000Z"),
    ];
    expect(singleNotification(group({ count: 312, latest }))).toBeNull();
  });

  test("a one-item group without its preview falls back to the group row", () => {
    expect(singleNotification(group({ latest: [] }))).toBeNull();
  });
});

describe("flattenGroupPages", () => {
  test("keeps the first occurrence of a group repeated across pages", () => {
    const today = group();
    const yesterday = group({ day: "2026-10-16" });
    const stock = group({ type: "low_stock" });
    const flat = flattenGroupPages([
      { items: [today, yesterday] },
      { items: [yesterday, stock] },
    ]);
    expect(flat).toEqual([today, yesterday, stock]);
  });
});

describe("newestLatestAt", () => {
  test("is undefined for no groups", () => {
    expect(newestLatestAt([])).toBeUndefined();
  });

  test("compares instants, not list order", () => {
    expect(
      newestLatestAt([
        group({ latestAt: "2026-10-16T10:00:00.000Z" }),
        group({ latestAt: "2026-10-17T08:00:00.000Z" }),
        group({ latestAt: "2026-10-16T23:59:59.999Z" }),
      ]),
    ).toBe("2026-10-17T08:00:00.000Z");
  });
});

describe("group summaries", () => {
  for (const locale of ["en", "es"] as const) {
    test(`${locale} has a pluralized summary for every notification type`, () => {
      const t = translator(locale);
      for (const type of NOTIFICATION_TYPES) {
        const key = groupSummaryKey(type);
        expect(t.has(key), `${locale}: ${type}`).toBe(true);
        const one = t(key, { count: 1 });
        const many = t(key, { count: 312 });
        expect(one).toMatch(/^1 /);
        expect(many).toMatch(/^312 /);
        expect(many.replace("312", "1")).not.toBe(one);
      }
    });
  }

  test("reads as a phrase", () => {
    const t = translator("en");
    expect(t(groupSummaryKey("critical_app_access"), { count: 312 })).toBe(
      "312 grants on critical applications",
    );
    expect(t(groupSummaryKey("workflow.manual_task"), { count: 1 })).toBe(
      "1 manual task waiting",
    );
  });
});
