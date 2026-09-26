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

// #1441: a model's SKU and description can be cleared with `null`; an empty string is still refused.
describe("UpdateAssetModelSchema — sku and description", () => {
  test("accepts null to clear the SKU and the description", () => {
    const parsed = UpdateAssetModelSchema.safeParse({
      sku: null,
      description: null,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ sku: null, description: null });
  });

  test("still accepts a value to change them", () => {
    expect(
      UpdateAssetModelSchema.safeParse({
        sku: " LAT-7440 ",
        description: "Business laptop",
      }).data,
    ).toEqual({ sku: "LAT-7440", description: "Business laptop" });
  });

  test("rejects an empty or blank string", () => {
    expect(UpdateAssetModelSchema.safeParse({ sku: "" }).success).toBe(false);
    expect(UpdateAssetModelSchema.safeParse({ description: "   " }).success).toBe(
      false,
    );
  });
});
