import { describe, expect, test } from "bun:test";
import {
  compareManualPages,
  groupIntoCategories,
  resolvePageLocale,
} from "./resolve";
import type { ManualPageSummary } from "./types";

/** Build a page summary fixture with just the fields the pure logic reads. */
function page(
  slug: string,
  category: string,
  subcategory: string,
  order: number,
  title = slug,
): ManualPageSummary {
  return {
    slug,
    resolvedLocale: "en",
    isFallback: false,
    frontmatter: { title, order, category, subcategory },
  };
}

describe("resolvePageLocale — locale resolution + es→en fallback (ADR-0062 §4)", () => {
  test("returns the requested locale, no fallback, when it has the file", () => {
    expect(resolvePageLocale("es", ["en", "es"])).toEqual({
      locale: "es",
      isFallback: false,
    });
  });

  test("falls back to en (flagged) when the requested es file is missing", () => {
    expect(resolvePageLocale("es", ["en"])).toEqual({
      locale: "en",
      isFallback: true,
    });
  });

  test("requested en present → no fallback", () => {
    expect(resolvePageLocale("en", ["en"])).toEqual({
      locale: "en",
      isFallback: false,
    });
  });

  test("returns null when the page exists in NO locale (→ caller 404s)", () => {
    expect(resolvePageLocale("es", [])).toBeNull();
  });

  test("returns null when present only in a non-default, non-requested locale", () => {
    // Only `es` has the file but `en` (the requested + default) does not → nothing to render.
    expect(resolvePageLocale("en", ["es"])).toBeNull();
  });
});

describe("compareManualPages — intra-subcategory ordering", () => {
  test("sorts ascending by order", () => {
    expect(
      compareManualPages(page("a", "c", "s", 2), page("b", "c", "s", 1)),
    ).toBeGreaterThan(0);
    expect(
      compareManualPages(page("a", "c", "s", 1), page("b", "c", "s", 2)),
    ).toBeLessThan(0);
  });

  test("ties break alphabetically by title, then slug", () => {
    expect(
      compareManualPages(
        page("a", "c", "s", 1, "Apples"),
        page("b", "c", "s", 1, "Bananas"),
      ),
    ).toBeLessThan(0);
    // Same order + same title → slug tiebreak keeps it deterministic.
    expect(
      compareManualPages(
        page("a", "c", "s", 1, "Same"),
        page("b", "c", "s", 1, "Same"),
      ),
    ).toBeLessThan(0);
  });
});

describe("groupIntoCategories — nested grouping in manifest order (issue #563)", () => {
  test("buckets pages by (category, subcategory) and sorts each by order", () => {
    const tree = groupIntoCategories([
      page("setup-b", "getting-started", "initial-setup", 2),
      page("setup-a", "getting-started", "initial-setup", 1),
      page("perms", "users-permissions", "permissions", 1),
    ]);

    expect(tree.map((c) => c.category)).toEqual([
      "getting-started",
      "users-permissions",
    ]);
    const setup = tree[0].subcategories[0];
    expect(setup.subcategory).toBe("initial-setup");
    // Within the subcategory, order 1 (setup-a) precedes order 2 (setup-b).
    expect(setup.pages.map((p) => p.slug)).toEqual(["setup-a", "setup-b"]);
  });

  test("emits categories AND subcategories in MANIFEST order, not insertion order", () => {
    // `assets` is declared before `secret-manager` in the manifest; declaring the pages
    // in the reverse order must NOT change the output order.
    const tree = groupIntoCategories([
      page("vault", "secret-manager", "vaults-members", 1),
      page("asset", "assets", "asset-basics", 1),
    ]);
    expect(tree.map((c) => c.category)).toEqual(["assets", "secret-manager"]);
  });

  test("orders subcategories within a category by manifest order", () => {
    // In `assets`, `models-categories` comes before `locations` in the manifest.
    const tree = groupIntoCategories([
      page("loc", "assets", "locations", 1),
      page("model", "assets", "models-categories", 1),
    ]);
    expect(tree[0].subcategories.map((s) => s.subcategory)).toEqual([
      "models-categories",
      "locations",
    ]);
  });

  test("only NON-EMPTY categories/subcategories render (sidebar grows with content)", () => {
    const tree = groupIntoCategories([
      page("perms", "users-permissions", "permissions", 1),
    ]);
    // Exactly one category, with exactly its one populated subcategory.
    expect(tree).toHaveLength(1);
    expect(tree[0].category).toBe("users-permissions");
    expect(tree[0].subcategories.map((s) => s.subcategory)).toEqual([
      "permissions",
    ]);
  });

  test("pages with a category/subcategory NOT in the manifest sort to the END, never crash", () => {
    const tree = groupIntoCategories([
      page("ghost", "made-up", "nowhere", 1),
      page("real", "getting-started", "initial-setup", 1),
    ]);
    expect(tree.map((c) => c.category)).toEqual(["getting-started", "made-up"]);
    expect(tree[1].subcategories[0].pages.map((p) => p.slug)).toEqual(["ghost"]);
  });

  test("empty input → empty category list", () => {
    expect(groupIntoCategories([])).toEqual([]);
  });
});
