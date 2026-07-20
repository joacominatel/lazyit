import { describe, expect, test } from "bun:test";
import {
  articleSlugFromPath,
  isKbTreeRoute,
  kbFolderHref,
  singleCategoryId,
} from "./kb-shell-route";

/**
 * Unit coverage for the persistent KB tree route-shell derivations (#1106 Phase 3). All four are pure
 * string projections over the current URL — the shell only wires `usePathname`/`useSearchParams` into
 * them — so they are tested directly. The two load-bearing behaviours: the tree renders on browse +
 * reading but NOT the editor surfaces, and a folder pick preserves other filters while dropping the
 * active search + paging.
 */

describe("articleSlugFromPath", () => {
  test("returns the slug on a reading route", () => {
    expect(articleSlugFromPath("/kb/vpn-setup")).toBe("vpn-setup");
  });
  test("decodes a percent-encoded slug", () => {
    expect(articleSlugFromPath("/kb/a%2Fb")).toBe("a/b");
  });
  test("is null on the browse list", () => {
    expect(articleSlugFromPath("/kb")).toBeNull();
  });
  test("is null on the create form", () => {
    expect(articleSlugFromPath("/kb/new")).toBeNull();
  });
  test("is null on the edit form (two segments, not a reading route)", () => {
    expect(articleSlugFromPath("/kb/vpn-setup/edit")).toBeNull();
  });
  test("is null outside /kb", () => {
    expect(articleSlugFromPath("/assets/abc")).toBeNull();
  });
});

describe("isKbTreeRoute", () => {
  test("shows the tree on the browse list", () => {
    expect(isKbTreeRoute("/kb")).toBe(true);
  });
  test("shows the tree on a reading route", () => {
    expect(isKbTreeRoute("/kb/vpn-setup")).toBe(true);
  });
  test("hides the tree on the create form", () => {
    expect(isKbTreeRoute("/kb/new")).toBe(false);
  });
  test("hides the tree on the edit form", () => {
    expect(isKbTreeRoute("/kb/vpn-setup/edit")).toBe(false);
  });
  test("hides the tree outside /kb", () => {
    expect(isKbTreeRoute("/assets")).toBe(false);
  });
});

describe("singleCategoryId", () => {
  test("returns the id when exactly one is present", () => {
    expect(singleCategoryId("folder1")).toBe("folder1");
  });
  test("is null for a multi-select param (never a misleading single node)", () => {
    expect(singleCategoryId("folder1,folder2")).toBeNull();
  });
  test("is null when empty or absent", () => {
    expect(singleCategoryId("")).toBeNull();
    expect(singleCategoryId(null)).toBeNull();
    expect(singleCategoryId(undefined)).toBeNull();
  });
  test("trims and ignores blank entries", () => {
    expect(singleCategoryId(" folder1 ,")).toBe("folder1");
  });
});

describe("kbFolderHref", () => {
  test("sets categoryId on the browse route", () => {
    expect(kbFolderHref("", "folder1")).toBe("/kb?categoryId=folder1");
  });
  test("clears categoryId for All articles", () => {
    expect(kbFolderHref("categoryId=folder1", null)).toBe("/kb");
  });
  test("drops the active search and paging but preserves other filters", () => {
    const href = kbFolderHref("q=vpn&status=DRAFT&offset=50", "folder1");
    const params = new URLSearchParams(href.split("?")[1]);
    expect(params.get("categoryId")).toBe("folder1");
    expect(params.get("status")).toBe("DRAFT");
    expect(params.get("q")).toBeNull();
    expect(params.get("offset")).toBeNull();
  });
  test("preserves other filters when clearing to All articles", () => {
    expect(kbFolderHref("status=PUBLISHED", null)).toBe("/kb?status=PUBLISHED");
  });
});
