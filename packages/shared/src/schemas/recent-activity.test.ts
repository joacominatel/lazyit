import { describe, expect, test } from "bun:test";
import { DEFAULT_PAGE_LIMIT } from "./pagination";
import {
  ACTIVITY_ACTOR_ME,
  ActivityEntityTypeSchema,
  RECENT_ACTIVITY_ACTIONS,
  RECENT_ACTIVITY_Q_MAX,
  RecentActivityActionSchema,
  RecentActivityItemSchema,
  RecentActivityPageSchema,
  RecentActivityQuerySchema,
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
  test("enumerates exactly the four activity pillars", () => {
    // DEBT-2 (issue #185) widened the enum with "user" (the UserHistory source).
    expect(ActivityEntityTypeSchema.options).toEqual([
      "asset",
      "application",
      "consumable",
      "user",
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

describe("RecentActivityActionSchema (allowlist of known verbs)", () => {
  test("enumerates exactly the view's source verbs", () => {
    expect([...RecentActivityActionSchema.options]).toEqual([
      "created",
      "status_changed",
      "assigned",
      "released",
      "location_changed",
      "model_changed",
      "specs_changed",
      "deleted",
      "restored",
      "granted",
      "revoked",
      "stock_in",
      "stock_out",
      "stock_adjustment",
      // UserHistory-specific verbs (DEBT-2, issue #185). created/deleted/restored are shared above.
      "updated",
      "role_changed",
      "password_reset_sent",
    ]);
  });

  test("accepts every catalog verb and rejects an unknown one", () => {
    for (const verb of RECENT_ACTIVITY_ACTIONS) {
      expect(RecentActivityActionSchema.safeParse(verb).success).toBe(true);
    }
    expect(RecentActivityActionSchema.safeParse("exploded").success).toBe(false);
  });
});

describe("RecentActivityQuerySchema (filterable feed query, issue #181)", () => {
  test("empty query → just the default pagination window (backward-compatible)", () => {
    const result = RecentActivityQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      // No filters present; the pagination half supplies the defaults.
      expect(result.data.limit).toBe(DEFAULT_PAGE_LIMIT);
      expect(result.data.offset).toBe(0);
      expect(result.data.entityType).toBeUndefined();
      expect(result.data.actorId).toBeUndefined();
      expect(result.data.action).toBeUndefined();
      expect(result.data.q).toBeUndefined();
    }
  });

  test("composes pagination (page → offset) with the filters", () => {
    const result = RecentActivityQuerySchema.safeParse({
      page: "2",
      limit: "10",
      entityType: "asset",
      action: "created",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(10);
      expect(result.data.offset).toBe(10); // (page-1)*limit
      expect(result.data.entityType).toBe("asset");
      expect(result.data.action).toBe("created");
    }
  });

  test("actorId accepts a uuid or the literal 'me', rejects anything else", () => {
    expect(
      RecentActivityQuerySchema.safeParse({
        actorId: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(true);
    const meResult = RecentActivityQuerySchema.safeParse({
      actorId: ACTIVITY_ACTOR_ME,
    });
    expect(meResult.success).toBe(true);
    if (meResult.success) expect(meResult.data.actorId).toBe("me");
    expect(
      RecentActivityQuerySchema.safeParse({ actorId: "someone" }).success,
    ).toBe(false);
  });

  test("rejects an unknown action verb (allowlist enforced)", () => {
    expect(
      RecentActivityQuerySchema.safeParse({ action: "exploded" }).success,
    ).toBe(false);
  });

  test("from/to must be ISO-8601 datetimes", () => {
    expect(
      RecentActivityQuerySchema.safeParse({
        from: "2026-05-01T00:00:00.000Z",
        to: "2026-06-01T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      RecentActivityQuerySchema.safeParse({ from: "yesterday" }).success,
    ).toBe(false);
  });

  test("q is trimmed and capped at the max length", () => {
    const trimmed = RecentActivityQuerySchema.safeParse({ q: "  laptop  " });
    expect(trimmed.success).toBe(true);
    if (trimmed.success) expect(trimmed.data.q).toBe("laptop");
    expect(
      RecentActivityQuerySchema.safeParse({
        q: "x".repeat(RECENT_ACTIVITY_Q_MAX + 1),
      }).success,
    ).toBe(false);
  });
});
