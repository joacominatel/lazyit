import { describe, expect, test } from "bun:test";
import {
  editDistance,
  findNearDuplicate,
  foldText,
  initialSuggestions,
  mergeCandidates,
  pushRecent,
  rankSuggestions,
  suggestKey,
  suggestKeyAction,
  tallyValues,
} from "./suggest";

const values = (list: { value: string }[]) => list.map((c) => c.value);

describe("normalization (#1470)", () => {
  test("folds case, accents and punctuation", () => {
    expect(foldText("  Telefónica, S.A. ")).toBe("telefonica sa");
    expect(foldText("Hewlett-Packard")).toBe("hewlett packard");
  });

  test("spellings of the same name share one key", () => {
    for (const spelling of ["Dell", "DELL", "Dell Inc.", "dell, inc", " dell  INC "]) {
      expect(suggestKey(spelling)).toBe("dell");
    }
    expect(suggestKey("Compumundo S.R.L.")).toBe("compumundo");
    expect(suggestKey("COMPUMUNDO SA")).toBe("compumundo");
    expect(suggestKey("Acme Corp. Ltd")).toBe("acme");
    expect(suggestKey("Hewlett Packard")).toBe(suggestKey("Hewlett-Packard"));
    expect(suggestKey("Cañón")).toBe("canon");
  });

  test("a value that is only a suffix keeps it", () => {
    expect(suggestKey("Co")).toBe("co");
    expect(suggestKey("S.A.")).toBe("sa");
  });

  test("different names keep different keys", () => {
    expect(suggestKey("Dell")).not.toBe(suggestKey("Delta"));
    expect(suggestKey("")).toBe("");
  });

  test("edit distance counts a transposition as one edit", () => {
    expect(editDistance("compumndo", "compumundo")).toBe(1);
    expect(editDistance("lenvoo", "lenovo")).toBe(1);
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("", "abc")).toBe(3);
  });
});

describe("rankSuggestions (#1470)", () => {
  const candidates = [
    { value: "Compudata", count: 2 },
    { value: "Compumundo", count: 14 },
    { value: "Dell Partner Cono Sur" },
    { value: "Mercado Libre" },
    { value: "ThinkPad Store" },
    { value: "Dell" },
  ];

  test("same value beats starts-with, which beats a word start, which beats contains", () => {
    const ranked = rankSuggestions(
      [{ value: "Dell" }, { value: "Delldirect" }, { value: "Shop Dell" }, { value: "Undelleted" }],
      "DELL INC",
    );
    expect(ranked[0]).toMatchObject({ value: "Dell", tier: 0 });
    expect(values(rankSuggestions(
      [{ value: "Undell" }, { value: "Shop Dell" }, { value: "Delldirect" }],
      "dell",
    ))).toEqual(["Delldirect", "Shop Dell", "Undell"]);
  });

  test("within a tier, the most used comes first", () => {
    expect(values(rankSuggestions(candidates, "comp"))).toEqual(["Compumundo", "Compudata"]);
  });

  test("then the most recently used", () => {
    const ranked = rankSuggestions(
      [
        { value: "Lenovo Old", lastUsedAt: "2025-01-01T00:00:00Z" },
        { value: "Lenovo New", lastUsedAt: "2026-09-01T00:00:00Z" },
      ],
      "lenovo",
    );
    expect(values(ranked)).toEqual(["Lenovo New", "Lenovo Old"]);
  });

  test("then the viewer's own recent order", () => {
    const ranked = rankSuggestions([{ value: "Acme A" }, { value: "Acme B" }], "acme", {
      recent: ["Acme B"],
    });
    expect(values(ranked)).toEqual(["Acme B", "Acme A"]);
  });

  test("matches a word start and initials", () => {
    expect(values(rankSuggestions(candidates, "cono"))).toEqual(["Dell Partner Cono Sur"]);
    expect(values(rankSuggestions(candidates, "tp"))).toEqual(["ThinkPad Store"]);
  });

  test("ignores accents and case", () => {
    expect(values(rankSuggestions([{ value: "Telefónica" }], "TELEFONI"))).toEqual(["Telefónica"]);
  });

  test("catches a close misspelling, scaled to the query length", () => {
    expect(values(rankSuggestions(candidates, "Compumndo"))).toEqual(["Compumundo"]);
    expect(values(rankSuggestions([{ value: "Lenovo" }], "lenvoo"))).toEqual(["Lenovo"]);
    // Three letters are too short to guess at.
    expect(rankSuggestions([{ value: "Dell" }], "dle")).toEqual([]);
  });

  test("a blank query matches nothing, and the limit holds", () => {
    expect(rankSuggestions(candidates, "  ")).toEqual([]);
    expect(rankSuggestions(candidates, "e", { limit: 2 })).toHaveLength(2);
  });
});

describe("initialSuggestions (#1470)", () => {
  test("recent values first, then the most used of the rest", () => {
    const { recent, others } = initialSuggestions(
      [
        { value: "Rare", count: 1 },
        { value: "Common", count: 40 },
        { value: "Mine", count: 3 },
        { value: "Middle", count: 9 },
      ],
      ["Mine", "Gone"],
      { otherLimit: 2 },
    );
    expect(values(recent)).toEqual(["Mine", "Gone"]);
    expect(recent[0]?.count).toBe(3);
    expect(values(others)).toEqual(["Common", "Middle"]);
  });
});

describe("findNearDuplicate (#1470)", () => {
  const existing = [
    { value: "Dell", count: 142 },
    { value: "DELL INC", count: 1 },
    { value: "Lenovo", count: 30 },
  ];

  test("offers the canonical spelling of a near-duplicate", () => {
    expect(findNearDuplicate("dell", existing)?.value).toBe("Dell");
    expect(findNearDuplicate("Dell, Inc.", existing)?.value).toBe("Dell");
    expect(findNearDuplicate("LENOVO", existing)?.value).toBe("Lenovo");
  });

  test("stays quiet for an exact value, a blank one or a new one", () => {
    expect(findNearDuplicate("Dell", existing)).toBeNull();
    expect(findNearDuplicate("DELL INC", existing)).toBeNull();
    expect(findNearDuplicate("  ", existing)).toBeNull();
    expect(findNearDuplicate("Acer", existing)).toBeNull();
  });
});

describe("candidates and the recent list (#1470)", () => {
  test("tallyValues counts each value and keeps its latest use", () => {
    const tally = tallyValues([
      { value: "Dell", at: "2026-01-01T00:00:00Z" },
      { value: "Dell", at: "2026-05-01T00:00:00Z" },
      { value: "HP" },
      { value: "" },
      { value: null },
    ]);
    expect(tally).toEqual([
      { value: "Dell", count: 2, lastUsedAt: "2026-05-01T00:00:00Z" },
      { value: "HP", count: 1, lastUsedAt: null },
    ]);
  });

  test("mergeCandidates keeps a count unknown when no source knows it", () => {
    expect(mergeCandidates([{ value: "A" }, { value: "A " }])).toEqual([{ value: "A" }]);
  });

  test("pushRecent moves a used value to the front, once, within the limit", () => {
    expect(pushRecent(["b", "a"], "a")).toEqual(["a", "b"]);
    expect(pushRecent(["a", "b", "c"], " d ", 3)).toEqual(["d", "a", "b"]);
    expect(pushRecent(["a"], "  ")).toEqual(["a"]);
  });
});

describe("suggestKeyAction — keyboard-only operation (#1470)", () => {
  const open = { open: true, active: 1, count: 3 };
  const closed = { open: false, active: -1, count: 3 };

  test("arrows open a closed list, then move with wrap-around", () => {
    expect(suggestKeyAction("ArrowDown", closed)).toEqual({ type: "open", highlight: 0 });
    expect(suggestKeyAction("ArrowUp", closed)).toEqual({ type: "open", highlight: 2 });
    expect(suggestKeyAction("ArrowDown", open)).toEqual({ type: "move", highlight: 2 });
    expect(suggestKeyAction("ArrowDown", { ...open, active: 2 })).toEqual({
      type: "move",
      highlight: 0,
    });
    expect(suggestKeyAction("ArrowDown", { ...open, active: -1 })).toEqual({
      type: "move",
      highlight: 0,
    });
    expect(suggestKeyAction("ArrowDown", { ...closed, count: 0 })).toEqual({ type: "none" });
  });

  test("Enter takes the highlighted option, and never swallows a submit otherwise", () => {
    expect(suggestKeyAction("Enter", open)).toEqual({
      type: "take",
      index: 1,
      preventDefault: true,
    });
    expect(suggestKeyAction("Enter", { ...open, active: -1 })).toEqual({ type: "none" });
    expect(suggestKeyAction("Enter", closed)).toEqual({ type: "none" });
  });

  test("Ctrl/Cmd+Enter keeps the text as typed", () => {
    expect(suggestKeyAction("Enter", { ...open, modKey: true })).toEqual({
      type: "keep",
      preventDefault: true,
    });
  });

  test("Tab takes the highlighted option and lets focus move on", () => {
    expect(suggestKeyAction("Tab", open)).toEqual({
      type: "take",
      index: 1,
      preventDefault: false,
    });
    expect(suggestKeyAction("Tab", { ...open, shiftKey: true })).toEqual({
      type: "keep",
      preventDefault: false,
    });
    expect(suggestKeyAction("Tab", { ...open, active: -1 })).toEqual({
      type: "keep",
      preventDefault: false,
    });
    expect(suggestKeyAction("Tab", closed)).toEqual({ type: "none" });
  });

  test("Esc closes the list and keeps the text; other keys type as usual", () => {
    expect(suggestKeyAction("Escape", open)).toEqual({ type: "keep", preventDefault: false });
    expect(suggestKeyAction("Escape", closed)).toEqual({ type: "none" });
    expect(suggestKeyAction("a", open)).toEqual({ type: "none" });
    expect(suggestKeyAction("Home", open)).toEqual({ type: "none" });
  });
});
