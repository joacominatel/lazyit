import { describe, expect, test } from "bun:test";
import {
  clampPanelWidth,
  isOverlayWidth,
  maxPanelWidth,
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_WIDTH_STORAGE_KEY,
  parseStoredPanelWidth,
  readStoredPanelWidth,
  toggledPanelWidth,
  widthForKey,
  widthFromPointer,
  writeStoredPanelWidth,
} from "./panel-width";

describe("clampPanelWidth", () => {
  test("keeps a width inside [min, max] for the viewport", () => {
    expect(clampPanelWidth(100, 1440)).toBe(PANEL_MIN_WIDTH);
    expect(clampPanelWidth(500, 1440)).toBe(500);
    expect(clampPanelWidth(5000, 1440)).toBe(maxPanelWidth(1440));
    expect(clampPanelWidth(5000, 4000)).toBe(PANEL_MAX_WIDTH);
  });

  test("always leaves the page a gutter, but never goes below the minimum", () => {
    expect(maxPanelWidth(1000)).toBe(904);
    expect(maxPanelWidth(300)).toBe(PANEL_MIN_WIDTH);
    expect(clampPanelWidth(600, 800)).toBe(600);
    expect(clampPanelWidth(750, 800)).toBe(704);
  });

  test("a non-number reads as the default", () => {
    expect(clampPanelWidth(Number.NaN, 1440)).toBe(PANEL_DEFAULT_WIDTH);
  });
});

describe("overlay and the expand toggle", () => {
  test("only a panel wider than the docked width overlays the page", () => {
    expect(isOverlayWidth(PANEL_DEFAULT_WIDTH)).toBe(false);
    expect(isOverlayWidth(PANEL_MIN_WIDTH)).toBe(false);
    expect(isOverlayWidth(PANEL_DEFAULT_WIDTH + 1)).toBe(true);
  });

  test("toggles between the default and the expanded width, clamped to the screen", () => {
    expect(toggledPanelWidth(PANEL_DEFAULT_WIDTH, 1440)).toBe(720);
    expect(toggledPanelWidth(720, 1440)).toBe(PANEL_DEFAULT_WIDTH);
    expect(toggledPanelWidth(PANEL_DEFAULT_WIDTH, 800)).toBe(704);
  });
});

describe("dragging and the keyboard", () => {
  test("the panel is anchored right: the pointer's distance from the right edge is the width", () => {
    expect(widthFromPointer(1440 - 600, 1440)).toBe(600);
    expect(widthFromPointer(1430, 1440)).toBe(PANEL_MIN_WIDTH);
    expect(widthFromPointer(0, 1440)).toBe(maxPanelWidth(1440));
  });

  test("ArrowLeft widens, ArrowRight narrows, Shift takes bigger steps", () => {
    expect(widthForKey("ArrowLeft", false, 400, 1440)).toBe(432);
    expect(widthForKey("ArrowRight", false, 400, 1440)).toBe(368);
    expect(widthForKey("ArrowLeft", true, 400, 1440)).toBe(528);
    expect(widthForKey("ArrowRight", true, 400, 1440)).toBe(PANEL_MIN_WIDTH);
  });

  test("Home/End jump to the limits, Enter resets, other keys are not handled", () => {
    expect(widthForKey("Home", false, 700, 1440)).toBe(PANEL_MIN_WIDTH);
    expect(widthForKey("End", false, 400, 1440)).toBe(maxPanelWidth(1440));
    expect(widthForKey("Enter", false, 700, 1440)).toBe(PANEL_DEFAULT_WIDTH);
    expect(widthForKey("a", false, 700, 1440)).toBeNull();
    expect(widthForKey("ArrowUp", false, 700, 1440)).toBeNull();
  });
});

describe("the stored preference", () => {
  test("parses a sane number and rejects anything else", () => {
    expect(parseStoredPanelWidth("640")).toBe(640);
    expect(parseStoredPanelWidth("640.6")).toBe(641);
    expect(parseStoredPanelWidth(null)).toBeNull();
    expect(parseStoredPanelWidth("")).toBeNull();
    expect(parseStoredPanelWidth("wide")).toBeNull();
    expect(parseStoredPanelWidth("10")).toBeNull();
    expect(parseStoredPanelWidth("99999")).toBeNull();
  });

  test("storage that throws reads as none and writes are ignored", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readStoredPanelWidth(throwing)).toBeNull();
    expect(() => writeStoredPanelWidth(throwing, 640)).not.toThrow();
    expect(readStoredPanelWidth(undefined)).toBeNull();
  });

  test("the default width is stored as no preference", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
    writeStoredPanelWidth(storage, 640);
    expect(map.get(PANEL_WIDTH_STORAGE_KEY)).toBe("640");
    expect(readStoredPanelWidth(storage)).toBe(640);
    writeStoredPanelWidth(storage, PANEL_DEFAULT_WIDTH);
    expect(map.has(PANEL_WIDTH_STORAGE_KEY)).toBe(false);
  });
});
