import { describe, expect, test } from "bun:test";
import { glowPosition, shouldTrackPointer } from "./pointer-glow";

const RECT = { left: 100, top: 50, width: 200, height: 100 };

describe("glowPosition", () => {
  test("maps the pointer into percentages of the element box", () => {
    expect(glowPosition(100, 50, RECT)).toEqual({ x: "0%", y: "0%" });
    expect(glowPosition(200, 100, RECT)).toEqual({ x: "50%", y: "50%" });
    expect(glowPosition(300, 150, RECT)).toEqual({ x: "100%", y: "100%" });
    expect(glowPosition(150, 75, RECT)).toEqual({ x: "25%", y: "25%" });
  });

  test("clamps a pointer outside the box to the nearest edge", () => {
    expect(glowPosition(40, 400, RECT)).toEqual({ x: "0%", y: "100%" });
    expect(glowPosition(900, -20, RECT)).toEqual({ x: "100%", y: "0%" });
  });

  test("rounds to a tenth of a percent", () => {
    expect(glowPosition(100 + 200 / 3, 50 + 100 / 3, RECT)).toEqual({ x: "33.3%", y: "33.3%" });
  });

  test("a box with no size, or a non-finite coordinate, answers the centre", () => {
    expect(glowPosition(10, 10, { left: 0, top: 0, width: 0, height: 0 })).toEqual({
      x: "50%",
      y: "50%",
    });
    expect(glowPosition(Number.NaN, 75, RECT)).toEqual({ x: "50%", y: "25%" });
  });
});

describe("shouldTrackPointer", () => {
  test("a mouse or a pen tracks", () => {
    expect(shouldTrackPointer("mouse", false)).toBe(true);
    expect(shouldTrackPointer("pen", false)).toBe(true);
  });

  test("touch never tracks", () => {
    expect(shouldTrackPointer("touch", false)).toBe(false);
    expect(shouldTrackPointer("", false)).toBe(false);
  });

  test("reduced motion never tracks, whatever the pointer", () => {
    expect(shouldTrackPointer("mouse", true)).toBe(false);
    expect(shouldTrackPointer("pen", true)).toBe(false);
  });
});
