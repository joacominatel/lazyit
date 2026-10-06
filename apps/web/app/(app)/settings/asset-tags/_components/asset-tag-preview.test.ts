import { describe, expect, test } from "bun:test";
import { parseAssetTagNumber, renderAssetTag } from "@lazyit/shared";
import {
  type AssetTagShapePart,
  assetTagPreviewState,
  assetTagShapeParts,
} from "./asset-tag-preview";

/**
 * Regression guard for the SECOND half of #1180 — the scheme-OFF branch of the settings preview.
 *
 * The first fix moved the enabled branch to the server's skip-existing lookup, but left the off branch
 * rendering `renderAssetTag(pattern, nextNumber)` under a "Tag shape" label. That is the SAME defect
 * with a new caption: with `LZ-1000` already on an asset the card still showed `LZ-1000`, a value the
 * allocator would never hand out — and calling it a shape made it less obviously wrong, not more.
 *
 * So the invariant here is not "the label changed", it is: **with the scheme off, nothing the card
 * renders may be readable as a tag under that scheme.** It is asserted by running the shared parser
 * (`parseAssetTagNumber` — the same function the allocator uses to decide whether a tag matches the
 * pattern) over the shape as it actually reaches the screen. A shape that parses is an allocatable
 * value; it must parse to `null`.
 *
 * The second guard covers the failure state: a preview whose query errored must be distinguishable
 * from one that is still in flight, or the card sits on "Checking…" forever with no way out.
 */

/** The digit-slot copy the editor really passes (`preview.digits`), for both shipped locales. */
const DIGIT_SLOT = {
  en: (width: number) => (width === 0 ? "a number" : `${width} digits`),
  es: (width: number) => (width === 0 ? "un número" : `${width} dígitos`),
};

/** The shape exactly as the card renders it: literals verbatim, the number slot as its label. */
function renderShape(parts: AssetTagShapePart[], locale: keyof typeof DIGIT_SLOT): string {
  return parts
    .map((part) => (part.kind === "literal" ? part.text : DIGIT_SLOT[locale](part.width)))
    .join("");
}

describe("assetTagShapeParts", () => {
  test("the scheme-off shape cannot be read as a tag of that scheme (the #1180 defect)", () => {
    const scheme = { prefix: "LZ-", suffix: undefined, width: 4 };

    // What the old off-branch rendered — a real, parseable, already-taken value.
    expect(parseAssetTagNumber(scheme, renderAssetTag(scheme, 1000))).toBe(1000);

    // What the shape renders now: not a tag, in either locale.
    const parts = assetTagShapeParts(scheme);
    expect(parseAssetTagNumber(scheme, renderShape(parts, "en"))).toBeNull();
    expect(parseAssetTagNumber(scheme, renderShape(parts, "es"))).toBeNull();
  });

  test("splits the pattern into its literal affixes and one number slot", () => {
    expect(assetTagShapeParts({ prefix: "IT-", suffix: "-HW", width: 4 })).toEqual([
      { kind: "literal", text: "IT-" },
      { kind: "number", width: 4 },
      { kind: "literal", text: "-HW" },
    ]);
  });

  test("an affix is a literal, never fused with the number slot", () => {
    // The reported operator's own standard is `IT#1000`, so a `#`-per-digit illustration would render
    // `IT#####` — unreadable. The slot is a separate part precisely so affix text cannot blur into it.
    const parts = assetTagShapeParts({ prefix: "IT#", width: 4 });

    expect(parts[0]).toEqual({ kind: "literal", text: "IT#" });
    expect(parts[1]).toEqual({ kind: "number", width: 4 });
  });

  test("no width (or zero) is an unpadded number slot, not a one-digit one", () => {
    expect(assetTagShapeParts({ prefix: "LZ-" })).toEqual([
      { kind: "literal", text: "LZ-" },
      { kind: "number", width: 0 },
    ]);
    expect(assetTagShapeParts({ prefix: "LZ-", width: 0 })).toEqual([
      { kind: "literal", text: "LZ-" },
      { kind: "number", width: 0 },
    ]);
  });

  test("blank and null affixes contribute no literal at all", () => {
    expect(assetTagShapeParts({ prefix: "   ", suffix: null, width: 3 })).toEqual([
      { kind: "number", width: 3 },
    ]);
  });

  test("affixes are shown as typed apart from the surrounding blanks", () => {
    // The API trims affixes on save, so the shape must show the trimmed value the operator will get.
    expect(assetTagShapeParts({ prefix: " IT- ", width: 2 })).toEqual([
      { kind: "literal", text: "IT-" },
      { kind: "number", width: 2 },
    ]);
  });
});

describe("assetTagPreviewState", () => {
  const answered = { tag: "IT-1001", exhausted: false };

  test("the scheme being off wins over any cached answer — never a number", () => {
    // The query is disabled when the scheme is off, but a previous session's answer can still sit in
    // the TanStack cache under the same key. It must not leak into the off state.
    expect(
      assetTagPreviewState({ enabled: false, isError: false, data: answered }),
    ).toEqual({ kind: "shape" });
  });

  test("a failed query is its own state, not an endless 'Checking…'", () => {
    expect(assetTagPreviewState({ enabled: true, isError: true })).toEqual({
      kind: "error",
    });
  });

  test("a failure never keeps showing the last tag as if it were current", () => {
    expect(
      assetTagPreviewState({ enabled: true, isError: true, data: answered }),
    ).toEqual({ kind: "error" });
  });

  test("in flight with nothing answered yet is loading", () => {
    expect(assetTagPreviewState({ enabled: true, isError: false })).toEqual({
      kind: "loading",
    });
  });

  test("an exhausted sequence is reported as such, not as a missing tag", () => {
    expect(
      assetTagPreviewState({
        enabled: true,
        isError: false,
        data: { tag: null, exhausted: true },
      }),
    ).toEqual({ kind: "exhausted" });
  });

  test("an answered preview carries the server's tag verbatim", () => {
    expect(
      assetTagPreviewState({ enabled: true, isError: false, data: answered }),
    ).toEqual({ kind: "tag", tag: "IT-1001" });
  });
});
