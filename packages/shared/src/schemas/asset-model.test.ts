import { describe, expect, test } from "bun:test";
import { UpdateAssetModelSchema } from "./asset-model";

const CATEGORY = "clh1abc0000xyz0000000abcd";

// #1315: a model's category can be cleared — `categoryId: null` is a change, not a no-op.
describe("UpdateAssetModelSchema — categoryId", () => {
  test("accepts null to clear the category", () => {
    const parsed = UpdateAssetModelSchema.safeParse({ categoryId: null });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ categoryId: null });
  });

  test("still accepts a cuid to change it", () => {
    expect(
      UpdateAssetModelSchema.safeParse({ categoryId: CATEGORY }).success,
    ).toBe(true);
  });

  test("rejects a non-cuid and an empty body", () => {
    expect(
      UpdateAssetModelSchema.safeParse({ categoryId: "not a cuid" }).success,
    ).toBe(false);
    expect(UpdateAssetModelSchema.safeParse({}).success).toBe(false);
  });
});
