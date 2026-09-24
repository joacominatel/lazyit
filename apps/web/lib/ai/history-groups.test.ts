import { describe, expect, test } from "bun:test";
import { groupByRecency, historyGroupOf } from "./history-groups";

const now = new Date("2026-09-24T10:00:00Z");

describe("history groups", () => {
  test("groups by calendar day in the instance time zone", () => {
    expect(historyGroupOf("2026-09-24T01:00:00Z", now, "UTC")).toBe("today");
    expect(historyGroupOf("2026-09-23T23:59:00Z", now, "UTC")).toBe("yesterday");
    expect(historyGroupOf("2026-09-19T12:00:00Z", now, "UTC")).toBe("week");
    expect(historyGroupOf("2026-09-10T12:00:00Z", now, "UTC")).toBe("older");
    // 01:00Z on the 24th is still the 23rd in Buenos Aires (UTC-3).
    expect(historyGroupOf("2026-09-24T01:00:00Z", now, "America/Argentina/Buenos_Aires")).toBe("yesterday");
  });

  test("a bad date is older, a future one is today", () => {
    expect(historyGroupOf("nope", now, "UTC")).toBe("older");
    expect(historyGroupOf("2026-09-30T00:00:00Z", now, "UTC")).toBe("today");
  });

  test("keeps the fixed order and drops empty groups", () => {
    const items = [
      { id: "a", updatedAt: "2026-09-24T09:00:00Z" },
      { id: "b", updatedAt: "2026-09-01T09:00:00Z" },
      { id: "c", updatedAt: "2026-09-24T08:00:00Z" },
    ];
    expect(groupByRecency(items, now, "UTC").map((g) => [g.group, g.items.map((i) => i.id)])).toEqual([
      ["today", ["a", "c"]],
      ["older", ["b"]],
    ]);
  });
});
