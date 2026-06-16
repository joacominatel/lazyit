import { describe, expect, test } from "bun:test";
import {
  compareManualPages,
  groupIntoSections,
  resolvePageLocale,
} from "./resolve";
import type { ManualPageSummary } from "./types";

/** Build a page summary fixture with just the fields the pure logic reads. */
function page(
  slug: string,
  section: string,
  order: number,
  title = slug,
): ManualPageSummary {
  return {
    slug,
    resolvedLocale: "en",
    isFallback: false,
    frontmatter: { title, order, section },
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

describe("compareManualPages — intra-section ordering", () => {
  test("sorts ascending by order", () => {
    expect(compareManualPages(page("a", "S", 2), page("b", "S", 1))).toBeGreaterThan(0);
    expect(compareManualPages(page("a", "S", 1), page("b", "S", 2))).toBeLessThan(0);
  });

  test("ties break alphabetically by title, then slug", () => {
    expect(
      compareManualPages(page("a", "S", 1, "Apples"), page("b", "S", 1, "Bananas")),
    ).toBeLessThan(0);
    // Same order + same title → slug tiebreak keeps it deterministic.
    expect(
      compareManualPages(page("a", "S", 1, "Same"), page("b", "S", 1, "Same")),
    ).toBeLessThan(0);
  });
});

describe("groupIntoSections — section grouping + sorting", () => {
  test("buckets pages by section and sorts each bucket by order", () => {
    const sections = groupIntoSections([
      page("intro", "Getting started", 2),
      page("welcome", "Getting started", 1),
      page("roles", "Permissions", 1),
    ]);

    expect(sections.map((s) => s.section)).toEqual([
      "Getting started",
      "Permissions",
    ]);
    // Within "Getting started", order 1 (welcome) precedes order 2 (intro).
    expect(sections[0].pages.map((p) => p.slug)).toEqual(["welcome", "intro"]);
  });

  test("orders sections by their smallest page order, then by name", () => {
    const sections = groupIntoSections([
      page("z", "Zebra", 5),
      page("a", "Alpha", 10),
      page("b", "Beta", 1),
    ]);
    // Beta has the smallest order (1) → first; Zebra (5) → second; Alpha (10) → last.
    expect(sections.map((s) => s.section)).toEqual(["Beta", "Zebra", "Alpha"]);
  });

  test("empty input → empty section list", () => {
    expect(groupIntoSections([])).toEqual([]);
  });
});
