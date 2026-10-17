import { describe, expect, test } from "bun:test";
import {
  FOLDER_TILE_CLASSES,
  folderColorIndex,
  folderTileClass,
} from "./kb-folder-color";

describe("folderColorIndex", () => {
  test("is deterministic for the same id", () => {
    const id = "clx1abcdefghijklmnopqrstu";
    expect(folderColorIndex(id)).toBe(folderColorIndex(id));
  });

  test("always lands inside the palette", () => {
    for (const id of ["", "a", "folder-1", "clx1abcdefghijklmnopqrstu", "z".repeat(500)]) {
      const index = folderColorIndex(id);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(FOLDER_TILE_CLASSES.length);
      expect(Number.isInteger(index)).toBe(true);
    }
  });

  test("spreads a realistic set of ids over more than one hue", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `cm${i}folder${i * 7}xyz`);
    const used = new Set(ids.map(folderColorIndex));
    expect(used.size).toBeGreaterThan(2);
  });
});

describe("folderTileClass", () => {
  test("returns a full, scanner-safe class string from the token palette", () => {
    const classes = folderTileClass("cm123");
    expect(FOLDER_TILE_CLASSES).toContain(classes as (typeof FOLDER_TILE_CLASSES)[number]);
    expect(classes).toMatch(/^bg-chart-[1-5]\/15 text-chart-[1-5]$/);
  });
});
