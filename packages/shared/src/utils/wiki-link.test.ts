import { describe, expect, test } from "bun:test";
import { SLUG_REGEX } from "./slug";
import { parseWikiLinks } from "./wiki-link";

describe("parseWikiLinks", () => {
  test("extracts a single [[slug]] token", () => {
    expect(parseWikiLinks("See [[network-setup]] for details.")).toEqual([
      "network-setup",
    ]);
  });

  test("extracts multiple distinct tokens in first-seen order", () => {
    const content = "Start at [[onboarding]], then [[vpn-setup]] and [[firewall-rules]].";
    expect(parseWikiLinks(content)).toEqual([
      "onboarding",
      "vpn-setup",
      "firewall-rules",
    ]);
  });

  test("de-duplicates repeated targets", () => {
    expect(parseWikiLinks("[[a]] and again [[a]] plus [[b]]")).toEqual(["a", "b"]);
  });

  test("normalizes a human-typed title to its slug (and collapses with the slug form)", () => {
    // `[[Network Setup]]` and `[[network-setup]]` resolve to the same target → one edge.
    expect(parseWikiLinks("[[Network Setup]] vs [[network-setup]]")).toEqual([
      "network-setup",
    ]);
  });

  test("strips a |display-text alias, keeping only the target", () => {
    expect(parseWikiLinks("[[network-setup|How to set up the network]]")).toEqual([
      "network-setup",
    ]);
  });

  test("strips a #heading anchor, keeping only the target", () => {
    expect(parseWikiLinks("[[network-setup#dns]]")).toEqual(["network-setup"]);
  });

  test("strips both alias and anchor together", () => {
    expect(parseWikiLinks("[[network-setup#dns|DNS section]]")).toEqual([
      "network-setup",
    ]);
  });

  test("drops anchor-only and empty tokens (no meaningless edge)", () => {
    expect(parseWikiLinks("jump to [[#section]] or [[ ]] or [[||]]")).toEqual([]);
  });

  test("returns an empty list when there are no tokens", () => {
    expect(parseWikiLinks("plain markdown with no links")).toEqual([]);
  });

  test("does not greedily span across separate tokens", () => {
    // Two adjacent tokens must parse as two, not one greedy `a]] [[b` capture.
    expect(parseWikiLinks("[[a]] [[b]]")).toEqual(["a", "b"]);
  });

  test("an unterminated [[ does not swallow the rest of the body", () => {
    expect(parseWikiLinks("[[ open with no close and [[real-one]] after")).toEqual([
      "real-one",
    ]);
  });

  test("every extracted slug is a valid slug shape", () => {
    const slugs = parseWikiLinks(
      "[[Hello World]] [[a.b.c]] [[Tëst 17]] [[multi---hyphen]]",
    );
    for (const s of slugs) expect(SLUG_REGEX.test(s)).toBe(true);
  });
});
