import { describe, expect, test } from "bun:test";
import { moveHighlight } from "./move-highlight";

describe("moveHighlight", () => {
  test("moves and wraps around; an empty list has no row", () => {
    expect(moveHighlight(0, 1, 3)).toBe(1);
    expect(moveHighlight(2, 1, 3)).toBe(0);
    expect(moveHighlight(0, -1, 3)).toBe(2);
    expect(moveHighlight(-1, 1, 3)).toBe(0);
    expect(moveHighlight(-1, -1, 3)).toBe(2);
    expect(moveHighlight(0, 1, 0)).toBe(-1);
  });
});
