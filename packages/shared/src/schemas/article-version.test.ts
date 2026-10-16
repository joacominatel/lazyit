import { describe, expect, it } from "bun:test";
import { ArticleVersionSchema } from "./article-version";

const ROW = {
  id: 7,
  articleId: "cmarticle00000000000000001",
  version: 3,
  title: "Runbook",
  content: "body",
  excerpt: null,
  status: "PUBLISHED",
  editedById: null,
  createdAt: "2026-10-15T12:00:00.000Z",
};

describe("ArticleVersionSchema", () => {
  it("accepts a version attributed to a service account (a folder move, ADR-0060 §10)", () => {
    const parsed = ArticleVersionSchema.parse({
      ...ROW,
      serviceAccountId: "cmsvcacct0000000000000001",
    });
    expect(parsed.serviceAccountId).toBe("cmsvcacct0000000000000001");
  });

  it("still accepts a row from a server that does not send serviceAccountId", () => {
    expect(ArticleVersionSchema.parse(ROW).serviceAccountId).toBeUndefined();
  });

  it("accepts a human-edited row with serviceAccountId null", () => {
    expect(
      ArticleVersionSchema.parse({
        ...ROW,
        editedById: "3f2b6c1e-8a4d-4f7b-9c2e-5d1a7b3e9f40",
        serviceAccountId: null,
      }).serviceAccountId,
    ).toBeNull();
  });
});
