import { describe, expect, test } from "bun:test";
import { parseTaxonomyTab, TAXONOMY_GROUPS, TAXONOMY_PANES } from "./taxonomy-tabs";
import { filterTaxonomy, usageLabel } from "./taxonomy-usage";

describe("parseTaxonomyTab", () => {
  test("every old ?tab= value still opens the same taxonomy", () => {
    expect(parseTaxonomyTab("asset")).toBe("asset");
    expect(parseTaxonomyTab("application")).toBe("application");
    expect(parseTaxonomyTab("consumable")).toBe("consumable");
    expect(parseTaxonomyTab("models")).toBe("models");
    expect(parseTaxonomyTab("statuses")).toBe("statuses");
  });

  test("the old article-categories tab points at the Knowledge Base", () => {
    expect(parseTaxonomyTab("article")).toBe("kb");
    expect(parseTaxonomyTab("kb")).toBe("kb");
  });

  test("absent or unknown falls back to asset categories", () => {
    expect(parseTaxonomyTab(null)).toBe("asset");
    expect(parseTaxonomyTab(undefined)).toBe("asset");
    expect(parseTaxonomyTab("nope")).toBe("asset");
  });

  test("the grouped list covers every pane exactly once", () => {
    const listed = TAXONOMY_GROUPS.flatMap((g) => g.panes);
    expect([...listed].sort()).toEqual([...TAXONOMY_PANES].sort());
  });
});

describe("usageLabel", () => {
  test("a count reads as that many of the noun", () => {
    expect(usageLabel("assets", 42)).toEqual({ key: "assets", count: 42 });
    expect(usageLabel("apps", 1)).toEqual({ key: "apps", count: 1 });
  });

  test("zero reads as unused", () => {
    expect(usageLabel("consumables", 0)).toEqual({ key: "unused", count: 0 });
  });

  test("no count from the API shows nothing", () => {
    expect(usageLabel("assets", null)).toBeNull();
    expect(usageLabel("assets", undefined)).toBeNull();
    expect(usageLabel("assets", Number.NaN)).toBeNull();
  });
});

describe("filterTaxonomy", () => {
  const rows = [
    { name: "Laptop", description: null },
    { name: "Server", description: "Físicos y virtuales" },
    { name: "Mobile", description: undefined },
  ];
  const fields = (r: (typeof rows)[number]) => [r.name, r.description];

  test("a blank query keeps every row", () => {
    expect(filterTaxonomy(rows, "  ", fields)).toEqual(rows);
  });

  test("matches name or description, ignoring case and accents", () => {
    expect(filterTaxonomy(rows, "LAP", fields).map((r) => r.name)).toEqual(["Laptop"]);
    expect(filterTaxonomy(rows, "fisicos", fields).map((r) => r.name)).toEqual(["Server"]);
    expect(filterTaxonomy(rows, "zzz", fields)).toEqual([]);
  });
});
