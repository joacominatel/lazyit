import { describe, expect, test } from "bun:test";
import {
  highlightSegments,
  resolveKbSearchMode,
  type KbSearchModeInput,
} from "./kb-search";

/**
 * Unit coverage for the healed KB search (#1106 Phase 3). Two load-bearing behaviours: the strong
 * Meili body search degrades to the server title/excerpt fallback (so it never looks broken after an
 * upgrade), and the client highlighter marks query terms in the fields a hit actually carries.
 */

const base: KbSearchModeInput = {
  searching: true,
  hasSearchData: true,
  degraded: false,
  searchErrored: false,
};

describe("resolveKbSearchMode", () => {
  test("no query → browse", () => {
    expect(resolveKbSearchMode({ ...base, searching: false })).toBe("browse");
  });
  test("healthy Meili result → search", () => {
    expect(resolveKbSearchMode(base)).toBe("search");
  });
  test("first result still loading → stays search (no fallback flash)", () => {
    expect(resolveKbSearchMode({ ...base, hasSearchData: false })).toBe(
      "search",
    );
  });
  test("degraded payload → fallback (Meili down / not yet reindexed)", () => {
    expect(resolveKbSearchMode({ ...base, degraded: true })).toBe("fallback");
  });
  test("search errored → fallback", () => {
    expect(resolveKbSearchMode({ ...base, searchErrored: true })).toBe(
      "fallback",
    );
  });
});

describe("highlightSegments", () => {
  test("marks a case-insensitive term occurrence", () => {
    expect(highlightSegments("The VPN setup guide", "vpn")).toEqual([
      { text: "The ", match: false },
      { text: "VPN", match: true },
      { text: " setup guide", match: false },
    ]);
  });
  test("marks every whitespace-separated term", () => {
    const segs = highlightSegments("firewall and vpn rules", "vpn firewall");
    expect(segs.filter((s) => s.match).map((s) => s.text)).toEqual([
      "firewall",
      "vpn",
    ]);
  });
  test("prefers the longer term on overlap", () => {
    const segs = highlightSegments("networking", "net networking");
    // The whole word is one marked run, not "net" + "working".
    expect(segs).toEqual([{ text: "networking", match: true }]);
  });
  test("no query → a single unmarked segment", () => {
    expect(highlightSegments("plain text", "  ")).toEqual([
      { text: "plain text", match: false },
    ]);
  });
  test("empty text → a single unmarked empty segment", () => {
    expect(highlightSegments("", "vpn")).toEqual([{ text: "", match: false }]);
  });
  test("treats regex metacharacters in the query literally", () => {
    expect(highlightSegments("a.b.c", ".")).toEqual([
      { text: "a", match: false },
      { text: ".", match: true },
      { text: "b", match: false },
      { text: ".", match: true },
      { text: "c", match: false },
    ]);
  });
});
