import { describe, expect, test } from "bun:test";
import {
  ApplicationGrantStatusSchema,
  ApplicationGrantSummarySchema,
  GRANT_EXPIRING_WITHIN_DAYS,
} from "./access-grant-list";

describe("ApplicationGrantStatusSchema (#1660)", () => {
  test("accepts the four views", () => {
    for (const status of ["active", "expiring", "revoked", "all"]) {
      expect(ApplicationGrantStatusSchema.parse(status)).toBe(status);
    }
  });

  test("rejects anything else", () => {
    expect(ApplicationGrantStatusSchema.safeParse("expired").success).toBe(false);
    expect(ApplicationGrantStatusSchema.safeParse("").success).toBe(false);
  });
});

describe("ApplicationGrantSummarySchema (#1660)", () => {
  const summary = {
    counts: { active: 3, expiring: 2, expired: 1, revoked: 4, all: 7 },
    levels: [
      { accessLevel: "admin", count: 2 },
      { accessLevel: null, count: 5 },
    ],
    offboardedHolders: 1,
    expiringWithinDays: GRANT_EXPIRING_WITHIN_DAYS,
  };

  test("accepts a summary with a no-level bucket", () => {
    expect(ApplicationGrantSummarySchema.parse(summary)).toEqual(summary);
  });

  test("accepts a null offboardedHolders (caller without user:read)", () => {
    expect(
      ApplicationGrantSummarySchema.parse({ ...summary, offboardedHolders: null })
        .offboardedHolders,
    ).toBeNull();
  });

  test("rejects a negative count", () => {
    expect(
      ApplicationGrantSummarySchema.safeParse({
        ...summary,
        counts: { ...summary.counts, revoked: -1 },
      }).success,
    ).toBe(false);
  });

  test("the expiring window matches the dashboard default (30 days)", () => {
    expect(GRANT_EXPIRING_WITHIN_DAYS).toBe(30);
  });
});
