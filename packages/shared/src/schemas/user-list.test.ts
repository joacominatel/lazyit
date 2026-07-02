import { describe, expect, test } from "bun:test";
import {
  MAX_RESOLVE_USER_IDS,
  ResolveUserIdsSchema,
} from "./user-list";

// A distinct, well-formed v4-shaped UUID per index (8-4-4-4-12, version 4, variant 8).
const uuid = (n: number) => {
  const hex = n.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
};

describe("ResolveUserIdsSchema (issue #961 — batch id→name resolver)", () => {
  test("accepts a bounded array of UUIDs", () => {
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ];
    expect(ResolveUserIdsSchema.parse(ids)).toEqual(ids);
  });

  test("accepts the empty array (no ids to resolve)", () => {
    expect(ResolveUserIdsSchema.parse([])).toEqual([]);
  });

  test("rejects a non-UUID element (garbage id → clean 400 at the controller)", () => {
    expect(ResolveUserIdsSchema.safeParse(["not-a-uuid"]).success).toBe(false);
  });

  test("rejects a batch over the cap", () => {
    const overCap = Array.from({ length: MAX_RESOLVE_USER_IDS + 1 }, (_, i) =>
      uuid(i),
    );
    expect(ResolveUserIdsSchema.safeParse(overCap).success).toBe(false);
  });

  test("caps at MAX_PAGE_LIMIT (ADR-0030 — reuses the list page ceiling)", () => {
    expect(MAX_RESOLVE_USER_IDS).toBe(200);
  });
});
