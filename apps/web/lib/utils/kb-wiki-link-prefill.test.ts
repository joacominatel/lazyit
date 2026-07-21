import { describe, expect, test } from "bun:test";
import {
  buildKbCreateHref,
  parseKbNewPrefill,
  PREFILL_TITLE_MAX_LENGTH,
} from "./kb-wiki-link-prefill";

/**
 * Unit coverage for the KB wiki-link create-on-click prefill (#1106 Phase 4). The builder round-trips
 * through the parser, and the parser is the untrusted-URL boundary — it must reject a non-slug and
 * bound the title, so a crafted `/kb/new?slug=…&title=…` can never inject into the create form.
 */

describe("buildKbCreateHref", () => {
  test("encodes the slug and a label-derived title", () => {
    expect(buildKbCreateHref("network-setup", "Network Setup")).toBe(
      "/kb/new?slug=network-setup&title=Network+Setup",
    );
  });

  test("omits the title when the label is blank", () => {
    expect(buildKbCreateHref("vpn-guide", "   ")).toBe("/kb/new?slug=vpn-guide");
  });

  test("URL-encodes special characters in the title", () => {
    // A label with an ampersand/space must not break out of the title param.
    expect(buildKbCreateHref("a-b", "A & B")).toBe(
      "/kb/new?slug=a-b&title=A+%26+B",
    );
  });

  test("round-trips: the built href parses back to the same slug + title", () => {
    const href = buildKbCreateHref("db-backups", "DB Backups");
    const query = Object.fromEntries(
      new URL(href, "https://x").searchParams.entries(),
    );
    expect(parseKbNewPrefill(query)).toEqual({
      slug: "db-backups",
      title: "DB Backups",
    });
  });
});

describe("parseKbNewPrefill", () => {
  test("keeps a valid slug and a trimmed title", () => {
    expect(
      parseKbNewPrefill({ slug: "network-setup", title: "  Network Setup  " }),
    ).toEqual({ slug: "network-setup", title: "Network Setup" });
  });

  test("drops an invalid slug (spaces/upper) but keeps the title", () => {
    // The form then derives a slug from the title — an invalid slug is never injected verbatim.
    expect(parseKbNewPrefill({ slug: "Not A Slug!", title: "Real Title" })).toEqual(
      { title: "Real Title" },
    );
  });

  test("drops a slug that exceeds the max length", () => {
    const tooLong = "a".repeat(61);
    expect(parseKbNewPrefill({ slug: tooLong })).toEqual({});
  });

  test("caps an over-long title to the max length", () => {
    const longTitle = "x".repeat(PREFILL_TITLE_MAX_LENGTH + 50);
    const result = parseKbNewPrefill({ title: longTitle });
    expect(result.title).toHaveLength(PREFILL_TITLE_MAX_LENGTH);
  });

  test("drops an empty/whitespace title", () => {
    expect(parseKbNewPrefill({ slug: "ok-slug", title: "   " })).toEqual({
      slug: "ok-slug",
    });
  });

  test("collapses a repeated param to its first value", () => {
    expect(
      parseKbNewPrefill({ slug: ["first-slug", "second-slug"] }),
    ).toEqual({ slug: "first-slug" });
  });

  test("returns an empty prefill when nothing usable is present", () => {
    expect(parseKbNewPrefill({})).toEqual({});
  });
});
