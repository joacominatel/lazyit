import { describe, expect, test } from "bun:test";
import {
  buildExcerpt,
  extractHeadings,
  normalizeForSearch,
  searchManual,
} from "./search";
import type { ManualSearchEntry } from "./search";

/** Build a search-index entry fixture; only the fields a test exercises need to be meaningful. */
function entry(
  slug: string,
  {
    title = slug,
    category = "General",
    subcategory = "General",
    headings = [],
    excerpt = "",
  }: Partial<
    Pick<
      ManualSearchEntry,
      "title" | "category" | "subcategory" | "headings" | "excerpt"
    >
  > = {},
): ManualSearchEntry {
  return {
    slug,
    title,
    category,
    subcategory,
    headings,
    excerpt,
    resolvedLocale: "en",
    isFallback: false,
  };
}

describe("normalizeForSearch — accent/case folding", () => {
  test("strips diacritics so accented text folds to its base letters", () => {
    expect(normalizeForSearch("Configuración")).toBe("configuracion");
    expect(normalizeForSearch("ESPAÑOL")).toBe("espanol");
  });

  test("lowercases and trims surrounding whitespace", () => {
    expect(normalizeForSearch("  Getting Started  ")).toBe("getting started");
  });

  test("an accent-free query equals the folded accented value (the match invariant)", () => {
    expect(normalizeForSearch("configuracion")).toBe(
      normalizeForSearch("Configuración"),
    );
  });
});

describe("searchManual — filtering", () => {
  const index = [
    entry("getting-started", {
      title: "Getting started",
      category: "Getting started",
      subcategory: "Initial setup",
    }),
    entry("configuration", {
      title: "Configuración",
      category: "Configuration",
      subcategory: "Instance settings",
      headings: ["Time zone", "Asset tags"],
      excerpt: "Set up your instance defaults.",
    }),
    entry("permissions", {
      title: "Permissions",
      category: "Users & Permissions",
      subcategory: "Permissions",
      excerpt: "Roles and access control.",
    }),
  ];

  test("empty / whitespace query returns no results (caller shows the full nav)", () => {
    expect(searchManual(index, "")).toEqual([]);
    expect(searchManual(index, "   ")).toEqual([]);
  });

  test("accent-insensitive: 'configuracion' matches the accented title 'Configuración'", () => {
    const hits = searchManual(index, "configuracion");
    expect(hits.map((h) => h.entry.slug)).toEqual(["configuration"]);
  });

  test("case-insensitive substring match", () => {
    expect(searchManual(index, "PERM").map((h) => h.entry.slug)).toEqual([
      "permissions",
    ]);
  });

  test("matches on a heading", () => {
    expect(searchManual(index, "time zone").map((h) => h.entry.slug)).toEqual([
      "configuration",
    ]);
  });

  test("matches on the subcategory label", () => {
    expect(searchManual(index, "instance settings").map((h) => h.entry.slug)).toEqual([
      "configuration",
    ]);
  });

  test("matches on the excerpt", () => {
    expect(searchManual(index, "roles").map((h) => h.entry.slug)).toEqual([
      "permissions",
    ]);
  });

  test("a query that matches nothing returns [] (drives the no-results state)", () => {
    expect(searchManual(index, "nonexistent-zzz")).toEqual([]);
  });
});

describe("searchManual — title-first ranking", () => {
  test("title > category > subcategory > heading > excerpt for the same term", () => {
    const index = [
      entry("uses-in-excerpt", {
        title: "Other page",
        category: "Other",
        subcategory: "Other",
        excerpt: "This mentions assets in the body only.",
      }),
      entry("assets", { title: "Assets", category: "Inventory", subcategory: "Basics" }),
      entry("uses-in-heading", {
        title: "Inventory overview",
        category: "Inventory",
        subcategory: "Basics",
        headings: ["Managing assets"],
      }),
      entry("uses-in-subcategory", {
        title: "Catalog",
        category: "Inventory",
        subcategory: "Assets",
      }),
      entry("uses-in-category", {
        title: "Catalog 2",
        category: "Assets",
        subcategory: "Basics",
      }),
    ];
    const hits = searchManual(index, "assets");
    // title → category → subcategory → heading → excerpt
    expect(hits.map((h) => h.entry.slug)).toEqual([
      "assets",
      "uses-in-category",
      "uses-in-subcategory",
      "uses-in-heading",
      "uses-in-excerpt",
    ]);
  });

  test("ties within a rank break alphabetically by title, then slug", () => {
    const index = [
      entry("b", { title: "Beta config" }),
      entry("a", { title: "Alpha config" }),
      entry("a2", { title: "Alpha config" }),
    ];
    const hits = searchManual(index, "config");
    // Same rank (all title hits) → title asc, then slug asc: "Alpha config"(a) , "Alpha config"(a2), "Beta config"(b)
    expect(hits.map((h) => h.entry.slug)).toEqual(["a", "a2", "b"]);
  });

  test("each entry yields at most one result, tagged with its best field rank", () => {
    const index = [
      entry("dup", {
        title: "Search everywhere",
        category: "Search category",
        subcategory: "Search subcategory",
        headings: ["Search heading"],
        excerpt: "search in the body",
      }),
    ];
    const hits = searchManual(index, "search");
    expect(hits).toHaveLength(1);
    expect(hits[0].rank).toBe(0); // matched in the title → best (0)
  });
});

describe("extractHeadings — ATX heading extraction", () => {
  test("pulls #/## headings in document order, stripping the # markers", () => {
    const md = "# Title\n\nIntro\n\n## First\n\ntext\n\n### Second";
    expect(extractHeadings(md)).toEqual(["Title", "First", "Second"]);
  });

  test("strips inline markdown (links, emphasis) from the heading text", () => {
    expect(extractHeadings("## See [the config](/help/config) page")).toEqual([
      "See the config page",
    ]);
    expect(extractHeadings("# **Bold** heading")).toEqual(["Bold heading"]);
  });

  test("ignores a '#' that is not a heading (no space after the hashes)", () => {
    expect(extractHeadings("#notaheading\nsome #hashtag text")).toEqual([]);
  });

  test("a body with no headings yields an empty array", () => {
    expect(extractHeadings("Just a paragraph of prose.")).toEqual([]);
  });
});

describe("buildExcerpt — plaintext lead extraction", () => {
  test("flattens prose to one line, dropping headings and code fences", () => {
    const md = "# Title\n\nWelcome to lazyit.\n\n```ts\nconst x = 1;\n```\n\nMore prose.";
    expect(buildExcerpt(md)).toBe("Welcome to lazyit. More prose.");
  });

  test("strips list bullets, blockquote markers and inline markdown", () => {
    const md = "> A quote\n\n- First **item**\n- A [link](/x) item";
    expect(buildExcerpt(md)).toBe("A quote First item A link item");
  });

  test("truncates on a word boundary with an ellipsis when over the cap", () => {
    const md = "alpha beta gamma delta epsilon zeta eta theta";
    const out = buildExcerpt(md, 20);
    expect(out.length).toBeLessThanOrEqual(21); // 20 + the single "…" char
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("  ");
    // Never cuts mid-word: the truncated head is whole words only.
    expect(out.slice(0, -1).trim().split(" ").every((w) => md.includes(w))).toBe(true);
  });

  test("a structure-only body (headings/code) yields an empty excerpt", () => {
    expect(buildExcerpt("# Only\n\n## Headings")).toBe("");
  });
});
