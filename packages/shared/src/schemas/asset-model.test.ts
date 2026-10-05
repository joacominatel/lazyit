import { describe, expect, test } from "bun:test";
import {
  ASSET_SPECS_MAX_DEPTH,
  ASSET_SPECS_MAX_KEYS,
  ASSET_SPECS_MAX_STRING_LENGTH,
} from "./asset";
import {
  AssetModelSchema,
  CreateAssetModelSchema,
  UpdateAssetModelSchema,
} from "./asset-model";

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

// #1329: model default specs are merged into a new asset's specs, so they carry the Asset.specs bound.
describe("AssetModel specs write bound", () => {
  const create = (specs: unknown) =>
    CreateAssetModelSchema.safeParse({ name: "Latitude", manufacturer: "Dell", specs });
  const update = (specs: unknown) => UpdateAssetModelSchema.safeParse({ specs });
  const nested = (depth: number) => {
    let node: Record<string, unknown> = { leaf: "x" };
    for (let i = 1; i < depth; i++) node = { a: node };
    return node;
  };
  const keys = (n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));

  test("accepts realistic defaults and specs at the bound", () => {
    expect(create({ ram: "16GB", cores: 8 }).success).toBe(true);
    expect(update(nested(ASSET_SPECS_MAX_DEPTH)).success).toBe(true);
    expect(update(keys(ASSET_SPECS_MAX_KEYS)).success).toBe(true);
  });

  test("rejects specs past the bound on create and update", () => {
    expect(create(nested(ASSET_SPECS_MAX_DEPTH + 1)).success).toBe(false);
    expect(update(keys(ASSET_SPECS_MAX_KEYS + 1)).success).toBe(false);
    expect(
      update({ blob: "x".repeat(ASSET_SPECS_MAX_STRING_LENGTH + 1) }).success,
    ).toBe(false);
  });

  test("AssetModelSchema still reads stored specs past the bound", () => {
    const row = {
      id: "cjld2cjxh0000qzrmn831i7rn",
      name: "Legacy",
      manufacturer: "Dell",
      sku: null,
      description: null,
      specs: { root: nested(ASSET_SPECS_MAX_DEPTH + 5) },
      categoryId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    };
    expect(AssetModelSchema.safeParse(row).success).toBe(true);
  });
});
