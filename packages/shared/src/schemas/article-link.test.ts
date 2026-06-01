import { describe, expect, it } from "bun:test";
import { CreateArticleLinkSchema } from "./article-link";

// Valid cuid-shaped ids (start with a letter, ≥ 24 chars) for the schema's z.cuid() fields.
const ASSET_ID = "classet000000000000000000";
const APP_ID = "clapp00000000000000000000";
const ARTICLE_ID = "clart00000000000000000000";

describe("CreateArticleLinkSchema — exactly-one-target (ADR-0042)", () => {
  it("accepts an asset-only link", () => {
    expect(CreateArticleLinkSchema.safeParse({ assetId: ASSET_ID }).success).toBe(
      true,
    );
  });

  it("accepts an application-only link", () => {
    expect(
      CreateArticleLinkSchema.safeParse({ applicationId: APP_ID }).success,
    ).toBe(true);
  });

  it("rejects a link with BOTH targets set", () => {
    expect(
      CreateArticleLinkSchema.safeParse({
        assetId: ASSET_ID,
        applicationId: APP_ID,
      }).success,
    ).toBe(false);
  });

  it("rejects a link with NEITHER target set", () => {
    expect(CreateArticleLinkSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an unknown extra field (strictObject)", () => {
    expect(
      CreateArticleLinkSchema.safeParse({
        assetId: ASSET_ID,
        articleId: ARTICLE_ID,
      }).success,
    ).toBe(false);
  });
});
