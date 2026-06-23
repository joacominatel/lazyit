import { describe, expect, mock, test } from "bun:test";
import { debounce, edgeStroke, gridPosition, statusTone } from "./canvas";

describe("statusTone", () => {
  test("maps each status to the app status language", () => {
    expect(statusTone("ONLINE")).toBe("success");
    expect(statusTone("OFFLINE")).toBe("danger");
    expect(statusTone("UNKNOWN")).toBe("neutral");
  });
});

describe("edgeStroke", () => {
  test("gives every edge kind a distinct token-backed stroke", () => {
    const strokes = [
      edgeStroke("RUNS_ON"),
      edgeStroke("MEMBER_OF"),
      edgeStroke("DEPENDS_ON"),
      edgeStroke("BACKS_UP_TO"),
      edgeStroke("CONNECTS_TO"),
    ];
    // All CSS variables…
    for (const s of strokes) expect(s).toMatch(/^var\(--[a-z-]+\)$/);
    // …and all distinct (so kinds are visually separable on the canvas).
    expect(new Set(strokes).size).toBe(strokes.length);
  });
});

describe("gridPosition", () => {
  test("lays nodes out left-to-right then wraps to the next row", () => {
    expect(gridPosition(0)).toEqual({ x: 0, y: 0 });
    // 4 columns → index 4 wraps to the second row.
    expect(gridPosition(4)).toEqual({ x: 0, y: 160 });
    // index 5 is column 1 of row 1.
    expect(gridPosition(5)).toEqual({ x: 260, y: 160 });
  });

  test("is deterministic in index (no reshuffle on re-render)", () => {
    expect(gridPosition(7)).toEqual(gridPosition(7));
  });
});

describe("debounce", () => {
  test("collapses a burst to a single trailing call with the latest args", async () => {
    const fn = mock((value: number) => value);
    const debounced = debounce(fn, 20);
    debounced(1);
    debounced(2);
    debounced(3);
    expect(fn).toHaveBeenCalledTimes(0);
    await new Promise((r) => setTimeout(r, 40));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith(3);
  });
});
