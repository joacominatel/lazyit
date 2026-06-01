import { describe, expect, test } from "bun:test";
import {
  BatchAssetStatusSchema,
  BatchIdsSchema,
  BatchResultSchema,
  BatchRevokeGrantsSchema,
  MAX_BATCH_IDS,
} from "./batch";

const ID_A = "clxaaaaaaaaaaaaaaaaaaaaaa";
const ID_B = "clxbbbbbbbbbbbbbbbbbbbbbb";

describe("BatchIdsSchema", () => {
  test("accepts a non-empty unique id list", () => {
    expect(BatchIdsSchema.safeParse({ ids: [ID_A, ID_B] }).success).toBe(true);
  });

  test("rejects an empty list", () => {
    expect(BatchIdsSchema.safeParse({ ids: [] }).success).toBe(false);
  });

  test("rejects duplicate ids", () => {
    expect(BatchIdsSchema.safeParse({ ids: [ID_A, ID_A] }).success).toBe(false);
  });

  test("rejects more than the hard maximum", () => {
    const ids = Array.from({ length: MAX_BATCH_IDS + 1 }, (_, i) =>
      `clx${i.toString().padStart(21, "0")}`,
    );
    expect(BatchIdsSchema.safeParse({ ids }).success).toBe(false);
  });

  test("rejects a non-cuid id", () => {
    expect(BatchIdsSchema.safeParse({ ids: ["not-a-cuid"] }).success).toBe(
      false,
    );
  });

  test("rejects unknown keys (strictObject)", () => {
    expect(
      BatchIdsSchema.safeParse({ ids: [ID_A], extra: 1 }).success,
    ).toBe(false);
  });
});

describe("BatchAssetStatusSchema", () => {
  test("accepts ids + a valid status", () => {
    expect(
      BatchAssetStatusSchema.safeParse({ ids: [ID_A], status: "RETIRED" })
        .success,
    ).toBe(true);
  });

  test("rejects an invalid status", () => {
    expect(
      BatchAssetStatusSchema.safeParse({ ids: [ID_A], status: "BROKEN" })
        .success,
    ).toBe(false);
  });
});

describe("BatchRevokeGrantsSchema", () => {
  test("accepts ids with no notes", () => {
    expect(BatchRevokeGrantsSchema.safeParse({ ids: [ID_A] }).success).toBe(
      true,
    );
  });

  test("accepts ids with a note", () => {
    expect(
      BatchRevokeGrantsSchema.safeParse({ ids: [ID_A], notes: "offboarding" })
        .success,
    ).toBe(true);
  });

  test("accepts null notes (explicit clear)", () => {
    expect(
      BatchRevokeGrantsSchema.safeParse({ ids: [ID_A], notes: null }).success,
    ).toBe(true);
  });
});

describe("BatchResultSchema", () => {
  test("validates a partial-success result", () => {
    const value = {
      requested: 2,
      succeeded: [ID_A],
      skipped: [{ id: ID_B, reason: "already_in_state" }],
    };
    expect(BatchResultSchema.safeParse(value).success).toBe(true);
  });
});
