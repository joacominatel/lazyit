import { describe, expect, it } from "bun:test";
import {
  ArticleApplicationIdFilterSchema,
  ArticleAssetIdFilterSchema,
  ArticleLinkedToFilterSchema,
  ArticleLinkedToSchema,
  ArticleStatusFilterSchema,
} from "./article-list";
import { ArticleStatusSchema } from "./article";

/**
 * Multi-value list-filter element schemas (#198). The array shape is parsed in the API controller
 * (comma-split + per-element validation); these schemas are the per-value allowlists. The tests pin
 * the allowlists and the single-value backward-compat contract: each individual value still validates,
 * an unknown value is rejected (→ 400 at the edge), and the filter aliases stay identical to the base
 * enums they re-export (so a status/linkedTo value means the same in a filter as anywhere else).
 */
describe("ArticleStatusFilterSchema — multi-value status filter element (#198)", () => {
  it("accepts each known status value", () => {
    expect(ArticleStatusFilterSchema.safeParse("DRAFT").success).toBe(true);
    expect(ArticleStatusFilterSchema.safeParse("PUBLISHED").success).toBe(true);
  });

  it("rejects an unknown status value (→ 400 at the edge)", () => {
    expect(ArticleStatusFilterSchema.safeParse("ARCHIVED").success).toBe(false);
    expect(ArticleStatusFilterSchema.safeParse("").success).toBe(false);
  });

  it("is the same allowlist as the base ArticleStatusSchema", () => {
    expect(ArticleStatusFilterSchema.options).toEqual(
      ArticleStatusSchema.options,
    );
  });
});

describe("ArticleLinkedToFilterSchema — multi-value linked-target filter element (#198)", () => {
  it("accepts each known target kind", () => {
    expect(ArticleLinkedToFilterSchema.safeParse("asset").success).toBe(true);
    expect(ArticleLinkedToFilterSchema.safeParse("application").success).toBe(
      true,
    );
  });

  it("rejects an unknown target kind (→ 400 at the edge)", () => {
    expect(ArticleLinkedToFilterSchema.safeParse("location").success).toBe(
      false,
    );
    expect(
      ArticleLinkedToFilterSchema.safeParse("asset,application").success,
    ).toBe(false);
  });

  it("aliases the base ArticleLinkedToSchema (same allowlist)", () => {
    expect(ArticleLinkedToFilterSchema.options).toEqual(
      ArticleLinkedToSchema.options,
    );
  });
});

describe("ArticleAssetIdFilterSchema / ArticleApplicationIdFilterSchema — specific-entity link filter elements (#213)", () => {
  // A representative well-formed cuid (24 chars, `c`-prefixed) — the shape Prisma assigns domain rows.
  const VALID_CUID = "clh1abc0000xyz0000000abcd";

  it("accepts a well-formed cuid for each specific-entity filter", () => {
    expect(ArticleAssetIdFilterSchema.safeParse(VALID_CUID).success).toBe(true);
    expect(ArticleApplicationIdFilterSchema.safeParse(VALID_CUID).success).toBe(
      true,
    );
  });

  it("rejects a malformed/garbage element (→ 400 at the edge, never silently dropped)", () => {
    expect(ArticleAssetIdFilterSchema.safeParse("not-a-cuid!").success).toBe(
      false,
    );
    expect(ArticleApplicationIdFilterSchema.safeParse("").success).toBe(false);
    // The comma-encoded list is split by the controller, never validated whole.
    expect(
      ArticleAssetIdFilterSchema.safeParse(`${VALID_CUID},${VALID_CUID}`)
        .success,
    ).toBe(false);
  });
});
