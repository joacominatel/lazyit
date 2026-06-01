import { describe, expect, test } from "bun:test";
import {
  ActivityEntityTypeSchema,
  RecentActivityItemSchema,
  RecentActivityPageSchema,
} from "./recent-activity";

/**
 * The unified dashboard activity feed contract (`GET /dashboard/activity`): a normalized row with a
 * nullable actor, a pillar-scoped entity, a machine verb and a human summary, wrapped in the
 * ADR-0030 `Page<T>` envelope.
 */

const validItem = {
  occurredAt: "2026-05-30T10:00:00.000Z",
  actorId: "11111111-1111-4111-8111-111111111111",
  actorName: "Admin User",
  entityType: "asset" as const,
  entityId: "casset0000000000000000001",
  action: "assigned",
  summary: "Admin User assigned an asset",
};

describe("RecentActivityItemSchema", () => {
  test("accepts a well-formed row", () => {
    expect(RecentActivityItemSchema.safeParse(validItem).success).toBe(true);
  });

  test("accepts a null actor (system / unknown / deleted actor)", () => {
    const result = RecentActivityItemSchema.safeParse({
      ...validItem,
      actorId: null,
      actorName: null,
    });
    expect(result.success).toBe(true);
  });

  test("rejects an unknown entityType", () => {
    const result = RecentActivityItemSchema.safeParse({
      ...validItem,
      entityType: "ticket",
    });
    expect(result.success).toBe(false);
  });

  test("rejects a non-ISO occurredAt", () => {
    const result = RecentActivityItemSchema.safeParse({
      ...validItem,
      occurredAt: "not-a-date",
    });
    expect(result.success).toBe(false);
  });

  test("rejects a non-uuid actorId", () => {
    const result = RecentActivityItemSchema.safeParse({
      ...validItem,
      actorId: "nope",
    });
    expect(result.success).toBe(false);
  });
});

describe("ActivityEntityTypeSchema", () => {
  test("enumerates exactly the three activity pillars", () => {
    expect(ActivityEntityTypeSchema.options).toEqual([
      "asset",
      "application",
      "consumable",
    ]);
  });
});

describe("RecentActivityPageSchema", () => {
  test("validates a well-formed page envelope", () => {
    const value = {
      items: [validItem],
      total: 1,
      limit: 20,
      offset: 0,
    };
    expect(RecentActivityPageSchema.safeParse(value).success).toBe(true);
  });

  test("rejects items that aren't valid activity rows", () => {
    const value = {
      items: [{ ...validItem, entityType: "bogus" }],
      total: 1,
      limit: 20,
      offset: 0,
    };
    expect(RecentActivityPageSchema.safeParse(value).success).toBe(false);
  });
});
