import { describe, expect, test } from "bun:test";
import { ConsumableMovementQuerySchema } from "./consumable-movement";

// Cross-field refine (round-2 correctness): an inverted from/to range is a 400, not a silent
// empty result.
describe("ConsumableMovementQuerySchema — from <= to", () => {
  test("accepts an empty query (no bounds)", () => {
    expect(ConsumableMovementQuerySchema.safeParse({}).success).toBe(true);
  });

  test("accepts from before to", () => {
    expect(
      ConsumableMovementQuerySchema.safeParse({
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-06-01T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  test("accepts from EQUAL to to", () => {
    const t = "2026-01-01T00:00:00.000Z";
    expect(
      ConsumableMovementQuerySchema.safeParse({ from: t, to: t }).success,
    ).toBe(true);
  });

  test("rejects from AFTER to (inverted range)", () => {
    expect(
      ConsumableMovementQuerySchema.safeParse({
        from: "2026-06-01T00:00:00.000Z",
        to: "2026-01-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  test("accepts an open-ended range (only one bound)", () => {
    expect(
      ConsumableMovementQuerySchema.safeParse({
        from: "2026-06-01T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      ConsumableMovementQuerySchema.safeParse({
        to: "2026-01-01T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});
