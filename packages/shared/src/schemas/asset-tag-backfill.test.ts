import { describe, expect, test } from "bun:test";
import {
  AssetTagBackfillApplySchema,
  AssetTagBackfillModeSchema,
  AssetTagBackfillPreviewQuerySchema,
  AssetTagSeedSuggestionQuerySchema,
  AssetTagSeedSuggestionSchema,
} from "./asset-tag-backfill";
import { parseAssetTagNumber } from "./asset-tag-scheme";

/**
 * Asset-tag estate-awareness contract (ADR-0068, #547). These prove the wire shapes (modes,
 * defaults, coercion) and — critically — the pure `parseAssetTagNumber` matcher the API uses for
 * BOTH the seed-suggestion parse and the normalize-non-conforming selection, so api and web agree on
 * exactly what "conforms" / what number a tag carries.
 */

describe("AssetTagBackfillModeSchema", () => {
  test("accepts the two modes; rejects anything else", () => {
    expect(AssetTagBackfillModeSchema.safeParse("untagged-only").success).toBe(true);
    expect(
      AssetTagBackfillModeSchema.safeParse("normalize-non-conforming").success,
    ).toBe(true);
    expect(AssetTagBackfillModeSchema.safeParse("all").success).toBe(false);
  });
});

describe("AssetTagBackfillPreviewQuerySchema (GET query, coerced)", () => {
  test("defaults: mode untagged-only, page 1, pageSize 25", () => {
    const parsed = AssetTagBackfillPreviewQuerySchema.parse({});
    expect(parsed).toEqual({ mode: "untagged-only", page: 1, pageSize: 25 });
  });

  test("coerces string page/pageSize (query strings) and keeps modelId", () => {
    const parsed = AssetTagBackfillPreviewQuerySchema.parse({
      mode: "normalize-non-conforming",
      modelId: "m1",
      page: "2",
      pageSize: "50",
    });
    expect(parsed).toEqual({
      mode: "normalize-non-conforming",
      modelId: "m1",
      page: 2,
      pageSize: 50,
    });
  });

  test("rejects pageSize over 100 and page below 1", () => {
    expect(AssetTagBackfillPreviewQuerySchema.safeParse({ pageSize: 101 }).success).toBe(
      false,
    );
    expect(AssetTagBackfillPreviewQuerySchema.safeParse({ page: 0 }).success).toBe(false);
  });
});

describe("AssetTagBackfillApplySchema (POST body)", () => {
  test("mode is required; excludeIds defaults to []", () => {
    const parsed = AssetTagBackfillApplySchema.parse({ mode: "untagged-only" });
    expect(parsed).toEqual({ mode: "untagged-only", excludeIds: [] });
    expect(AssetTagBackfillApplySchema.safeParse({}).success).toBe(false);
  });

  test("carries modelId + excludeIds through", () => {
    const parsed = AssetTagBackfillApplySchema.parse({
      mode: "normalize-non-conforming",
      modelId: "m1",
      excludeIds: ["a1", "a2"],
    });
    expect(parsed.excludeIds).toEqual(["a1", "a2"]);
    expect(parsed.modelId).toBe("m1");
  });
});

describe("AssetTagSeedSuggestion (query + response)", () => {
  test("query coerces width; affixes optional", () => {
    expect(AssetTagSeedSuggestionQuerySchema.parse({ width: "5" }).width).toBe(5);
    expect(AssetTagSeedSuggestionQuerySchema.parse({}).prefix).toBeUndefined();
  });

  test("response allows a null maxExistingNumber (nothing matched)", () => {
    expect(
      AssetTagSeedSuggestionSchema.safeParse({
        suggestedStartNumber: 1,
        matchedCount: 0,
        maxExistingNumber: null,
      }).success,
    ).toBe(true);
  });
});

describe("parseAssetTagNumber (shared conformance matcher)", () => {
  test("matches prefix + digits + suffix → the parsed number", () => {
    expect(parseAssetTagNumber({ prefix: "IT-", suffix: null }, "IT-1000")).toBe(1000);
    expect(parseAssetTagNumber({ prefix: "IT-", suffix: "-X" }, "IT-42-X")).toBe(42);
    // Zero-padded body conforms (width is presentational, not enforced here).
    expect(parseAssetTagNumber({ prefix: "IT-", suffix: null }, "IT-00042")).toBe(42);
    // No affixes → the whole tag must be digits.
    expect(parseAssetTagNumber({ prefix: null, suffix: null }, "777")).toBe(777);
  });

  test("returns null for a tag that does NOT conform", () => {
    // Wrong prefix.
    expect(parseAssetTagNumber({ prefix: "IT-", suffix: null }, "LAB-1000")).toBeNull();
    // Wrong suffix.
    expect(parseAssetTagNumber({ prefix: "IT-", suffix: "-X" }, "IT-42-Y")).toBeNull();
    // Non-numeric middle.
    expect(parseAssetTagNumber({ prefix: "IT-", suffix: null }, "IT-ABC")).toBeNull();
    // Empty middle (affixes consume the whole string).
    expect(parseAssetTagNumber({ prefix: "IT-", suffix: null }, "IT-")).toBeNull();
    // A purely manual freeform tag under no-affix scheme that isn't all digits.
    expect(parseAssetTagNumber({ prefix: null, suffix: null }, "SRV-A1")).toBeNull();
    // Overlapping affixes longer than the tag.
    expect(parseAssetTagNumber({ prefix: "ITLONG-", suffix: "-X" }, "IT-X")).toBeNull();
  });
});
