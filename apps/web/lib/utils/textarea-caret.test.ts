import { describe, expect, test } from "bun:test";
import { placePopupBelowCaret } from "./textarea-caret";

const BOX = { width: 600, height: 420 };
const POPUP = { width: 320, height: 256 };

describe("placePopupBelowCaret", () => {
  test("anchors the popup just below the caret's line by default", () => {
    const { top, left } = placePopupBelowCaret(
      { top: 40, left: 80, height: 20 },
      BOX,
      POPUP,
      4,
    );
    // top = caret.top + height + gap = 40 + 20 + 4
    expect(top).toBe(64);
    // left clamps to caret.left when it fits
    expect(left).toBe(80);
  });

  test("flips above the caret line when below would overflow the bottom", () => {
    // Caret near the bottom: below (380+20+4=404) + popup 256 = 660 > 420 → flip above.
    const { top } = placePopupBelowCaret(
      { top: 380, left: 0, height: 20 },
      BOX,
      POPUP,
      4,
    );
    // above = caret.top - gap - popup.height = 380 - 4 - 256 = 120
    expect(top).toBe(120);
  });

  test("clamps the flipped-above top to >= 0 (tall popup, caret near top)", () => {
    // Box too short for the popup either way; caret high → above goes negative → clamp to 0.
    const { top } = placePopupBelowCaret(
      { top: 10, left: 0, height: 20 },
      { width: 600, height: 200 },
      POPUP,
      4,
    );
    // below 34 + 256 = 290 > 200 → flip; above = 10-4-256 < 0 → clamp 0.
    expect(top).toBe(0);
  });

  test("clamps left so the popup never spills past the right edge", () => {
    const { left } = placePopupBelowCaret(
      { top: 0, left: 580, height: 20 },
      BOX,
      POPUP,
      4,
    );
    // maxLeft = 600 - 320 = 280; caret.left 580 clamps to 280.
    expect(left).toBe(280);
  });

  test("never returns a negative left", () => {
    const { left } = placePopupBelowCaret(
      { top: 0, left: -50, height: 20 },
      BOX,
      POPUP,
      4,
    );
    expect(left).toBe(0);
  });

  test("clamps left to 0 when the popup is wider than the box", () => {
    const { left } = placePopupBelowCaret(
      { top: 0, left: 100, height: 20 },
      { width: 200, height: 420 },
      POPUP,
      4,
    );
    // maxLeft = max(0, 200-320) = 0 → left clamps to 0.
    expect(left).toBe(0);
  });
});
