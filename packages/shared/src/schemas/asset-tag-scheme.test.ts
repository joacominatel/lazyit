import { describe, expect, test } from "bun:test";
import {
  ASSET_TAG_AFFIX_MAX,
  ASSET_TAG_WIDTH_MAX,
  AssetTagSchemeSchema,
  UpdateAssetTagSchemeSchema,
  renderAssetTag,
} from "./asset-tag-scheme";
import { INT4_MAX } from "./primitives";

/**
 * AssetTagScheme contract (ADR-0063, #363). The decisive rule the ADR sets — a config WITHOUT the
 * running number is rejected at the boundary — is satisfied STRUCTURALLY here: the sequence is an
 * explicit, always-present field (`nextNumber` / `startNumber`), not a `{num}` token in a free-text
 * template. So there is literally no payload shape that omits the running number; these tests prove
 * the affix/width bounds, the structural sequence, and that `renderAssetTag` matches the documented
 * `prefix + zeroPad(num, width) + suffix` formula the API allocates with.
 */

describe("UpdateAssetTagSchemeSchema (PUT body)", () => {
  test("a minimal scheme is just { enabled } — the sequence is structural, never omittable", () => {
    // The only required field is `enabled`. There is no `{num}`/template field to forget, so a
    // scheme without a running number is UNREPRESENTABLE — the ADR's reject-missing-{num} rule.
    expect(UpdateAssetTagSchemeSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(UpdateAssetTagSchemeSchema.safeParse({ enabled: false }).success).toBe(true);
  });

  test("rejects an empty body (enabled is required)", () => {
    expect(UpdateAssetTagSchemeSchema.safeParse({}).success).toBe(false);
  });

  test("accepts a full scheme (prefix + suffix + width + startNumber)", () => {
    const parsed = UpdateAssetTagSchemeSchema.parse({
      enabled: true,
      prefix: "LAZY-",
      suffix: "-X",
      width: 5,
      startNumber: 42,
    });
    expect(parsed).toEqual({
      enabled: true,
      prefix: "LAZY-",
      suffix: "-X",
      width: 5,
      startNumber: 42,
    });
  });

  test("trims affixes and drops empty/whitespace ones (no empty-string affix)", () => {
    expect(UpdateAssetTagSchemeSchema.parse({ enabled: true, prefix: "  IT- " }).prefix).toBe(
      "IT-",
    );
    // A whitespace-only affix trims to "" which fails min(1) → 400 (never a silent empty affix).
    expect(UpdateAssetTagSchemeSchema.safeParse({ enabled: true, prefix: "   " }).success).toBe(
      false,
    );
  });

  test("rejects an over-long affix and an over-wide width", () => {
    expect(
      UpdateAssetTagSchemeSchema.safeParse({
        enabled: true,
        prefix: "x".repeat(ASSET_TAG_AFFIX_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      UpdateAssetTagSchemeSchema.safeParse({
        enabled: true,
        width: ASSET_TAG_WIDTH_MAX + 1,
      }).success,
    ).toBe(false);
  });

  test("width and startNumber accept 0 but reject negatives and beyond int4", () => {
    expect(UpdateAssetTagSchemeSchema.safeParse({ enabled: true, width: 0 }).success).toBe(true);
    expect(UpdateAssetTagSchemeSchema.safeParse({ enabled: true, startNumber: 0 }).success).toBe(
      true,
    );
    expect(UpdateAssetTagSchemeSchema.safeParse({ enabled: true, width: -1 }).success).toBe(false);
    expect(
      UpdateAssetTagSchemeSchema.safeParse({ enabled: true, startNumber: -1 }).success,
    ).toBe(false);
    expect(
      UpdateAssetTagSchemeSchema.safeParse({ enabled: true, startNumber: INT4_MAX + 1 }).success,
    ).toBe(false);
  });

  test("rejects unknown keys (strictObject — no smuggled nextNumber / template)", () => {
    expect(
      UpdateAssetTagSchemeSchema.safeParse({ enabled: true, template: "LAZY-{num}" }).success,
    ).toBe(false);
    expect(
      UpdateAssetTagSchemeSchema.safeParse({ enabled: true, nextNumber: 9 }).success,
    ).toBe(false);
  });
});

describe("AssetTagSchemeSchema (GET response)", () => {
  test("accepts the explicit unset/disabled state with defaults", () => {
    const now = new Date().toISOString();
    expect(
      AssetTagSchemeSchema.safeParse({
        prefix: null,
        suffix: null,
        width: null,
        nextNumber: 1,
        enabled: false,
        createdAt: now,
        updatedAt: now,
      }).success,
    ).toBe(true);
  });
});

describe("renderAssetTag (shared allocation/preview formula)", () => {
  test("prefix + zeroPad(num, width) + suffix", () => {
    expect(renderAssetTag({ prefix: "LAZY-", width: 5 }, 42)).toBe("LAZY-00042");
    expect(renderAssetTag({ prefix: "IT-2026-", width: 4 }, 107)).toBe("IT-2026-0107");
  });

  test("no width / zero width = no padding", () => {
    expect(renderAssetTag({ prefix: "LAZY-" }, 42)).toBe("LAZY-42");
    expect(renderAssetTag({ prefix: "LAZY-", width: 0 }, 42)).toBe("LAZY-42");
  });

  test("a number already wider than the pad is unchanged", () => {
    expect(renderAssetTag({ prefix: "A", width: 2 }, 12345)).toBe("A12345");
  });

  test("null/absent affixes render as empty (suffix supported)", () => {
    expect(renderAssetTag({ prefix: null, suffix: null, width: null }, 7)).toBe("7");
    expect(renderAssetTag({ width: 3, suffix: "-EOL" }, 7)).toBe("007-EOL");
  });
});
