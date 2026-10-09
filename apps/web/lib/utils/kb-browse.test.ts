import { describe, expect, test } from "bun:test";
import {
  kbNarrowedBeyondView,
  DEFAULT_KB_SORT,
  kbActiveView,
  kbBrowseMode,
  kbSortParam,
  kbViewHref,
  parseIncludeSubfolders,
  parseKbSort,
  statusSegment,
  statusValuesFor,
} from "./kb-browse";

const params = (qs: string) => new URLSearchParams(qs);

describe("kbActiveView", () => {
  test("no params is All articles", () => {
    expect(kbActiveView(params(""))).toBe("all");
  });
  test("status=DRAFT alone is My drafts", () => {
    expect(kbActiveView(params("status=DRAFT"))).toBe("drafts");
  });
  test("both statuses, or published only, stay on All", () => {
    expect(kbActiveView(params("status=DRAFT,PUBLISHED"))).toBe("all");
    expect(kbActiveView(params("status=PUBLISHED"))).toBe("all");
  });
  test("view=recent wins over everything else", () => {
    expect(kbActiveView(params("view=recent&categoryId=c1&status=DRAFT"))).toBe("recent");
  });
  test("an unknown view value is ignored", () => {
    expect(kbActiveView(params("view=bogus"))).toBe("all");
  });
  test("any linked narrowing is Linked, even with a status", () => {
    expect(kbActiveView(params("linked=only"))).toBe("linked");
    expect(kbActiveView(params("linkedTo=asset"))).toBe("linked");
    expect(kbActiveView(params("assetId=c1"))).toBe("linked");
    expect(kbActiveView(params("applicationId=c2&status=DRAFT"))).toBe("linked");
  });
  test("a single open folder highlights no view", () => {
    expect(kbActiveView(params("categoryId=c1"))).toBeNull();
    expect(kbActiveView(params("categoryId=c1&status=DRAFT"))).toBeNull();
  });
  test("several folders (a chip combination) read as All", () => {
    expect(kbActiveView(params("categoryId=c1,c2"))).toBe("all");
  });
});

describe("kbViewHref", () => {
  test("each view maps to a clean scope", () => {
    expect(kbViewHref("all")).toBe("/kb");
    expect(kbViewHref("drafts")).toBe("/kb?status=DRAFT");
    expect(kbViewHref("recent")).toBe("/kb?view=recent");
    expect(kbViewHref("linked")).toBe("/kb?linked=only");
  });
  test("round-trips through kbActiveView", () => {
    for (const view of ["all", "drafts", "recent", "linked"] as const) {
      const href = kbViewHref(view);
      expect(kbActiveView(params(href.split("?")[1] ?? ""))).toBe(view);
    }
  });
});

describe("kbBrowseMode", () => {
  test("home, view, folder, recent and search", () => {
    expect(kbBrowseMode(params(""))).toBe("home");
    expect(kbBrowseMode(params("status=PUBLISHED"))).toBe("home");
    expect(kbBrowseMode(params("status=DRAFT"))).toBe("view");
    expect(kbBrowseMode(params("linked=only"))).toBe("view");
    expect(kbBrowseMode(params("categoryId=c1"))).toBe("folder");
    expect(kbBrowseMode(params("view=recent"))).toBe("recent");
  });
  test("an active query always searches", () => {
    expect(kbBrowseMode(params("q=vpn&categoryId=c1"))).toBe("search");
    expect(kbBrowseMode(params("q=vpn&view=recent"))).toBe("search");
  });
  test("a blank query does not search", () => {
    expect(kbBrowseMode(params("q=%20%20"))).toBe("home");
  });
});

describe("parseKbSort / kbSortParam", () => {
  test("accepts the three allowlisted orders", () => {
    expect(parseKbSort("updated")).toBe("updated");
    expect(parseKbSort("title")).toBe("title");
    expect(parseKbSort("created")).toBe("created");
  });
  test("falls back to the default for absent or tampered values", () => {
    expect(parseKbSort(null)).toBe(DEFAULT_KB_SORT);
    expect(parseKbSort(undefined)).toBe(DEFAULT_KB_SORT);
    expect(parseKbSort("TITLE")).toBe(DEFAULT_KB_SORT);
    expect(parseKbSort("drop table")).toBe(DEFAULT_KB_SORT);
  });
  test("the default is never sent to the API", () => {
    expect(kbSortParam("updated")).toBeUndefined();
    expect(kbSortParam("title")).toBe("title");
    expect(kbSortParam("created")).toBe("created");
  });
});

describe("parseIncludeSubfolders", () => {
  test("only the literal true turns it on", () => {
    expect(parseIncludeSubfolders("true")).toBe(true);
    expect(parseIncludeSubfolders("1")).toBe(false);
    expect(parseIncludeSubfolders("TRUE")).toBe(false);
    expect(parseIncludeSubfolders(null)).toBe(false);
  });
});

describe("statusSegment / statusValuesFor", () => {
  test("exactly one status selects its segment", () => {
    expect(statusSegment(["DRAFT"])).toBe("DRAFT");
    expect(statusSegment(["PUBLISHED", "PUBLISHED"])).toBe("PUBLISHED");
  });
  test("none, both or unknown read as All", () => {
    expect(statusSegment([])).toBe("all");
    expect(statusSegment(["DRAFT", "PUBLISHED"])).toBe("all");
    expect(statusSegment(["ARCHIVED"])).toBe("all");
  });
  test("segments write back the matching filter", () => {
    expect(statusValuesFor("all")).toEqual([]);
    expect(statusValuesFor("DRAFT")).toEqual(["DRAFT"]);
    expect(statusValuesFor("PUBLISHED")).toEqual(["PUBLISHED"]);
  });
});

describe("kbNarrowedBeyondView", () => {
  const p = (query: string) => new URLSearchParams(query);

  test("My drafts alone is not a narrowing, so an empty drafts view reads as empty, not unmatched", () => {
    expect(kbNarrowedBeyondView(p("status=DRAFT"))).toBe(false);
  });

  test("Linked alone is not a narrowing; a status or a specific target is", () => {
    expect(kbNarrowedBeyondView(p("linked=only"))).toBe(false);
    expect(kbNarrowedBeyondView(p("linked=only&status=PUBLISHED"))).toBe(true);
    expect(kbNarrowedBeyondView(p("linkedTo=asset"))).toBe(true);
    expect(kbNarrowedBeyondView(p("assetId=classet000000000000000000"))).toBe(true);
  });

  test("on All articles and in a folder, a status or a linked filter narrows", () => {
    expect(kbNarrowedBeyondView(p(""))).toBe(false);
    expect(kbNarrowedBeyondView(p("status=PUBLISHED"))).toBe(true);
    const folder = "categoryId=clfolder00000000000000000";
    expect(kbNarrowedBeyondView(p(folder))).toBe(false);
    expect(kbNarrowedBeyondView(p(`${folder}&status=DRAFT`))).toBe(true);
    expect(kbNarrowedBeyondView(p(`${folder}&linked=only`))).toBe(true);
  });

  test("search and Recent are never narrowed here", () => {
    expect(kbNarrowedBeyondView(p("q=vpn&status=DRAFT"))).toBe(false);
    expect(kbNarrowedBeyondView(p("view=recent&status=DRAFT"))).toBe(false);
  });
});
