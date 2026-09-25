import { describe, expect, test } from "bun:test";
import {
  fromNoneAwareValue,
  NO_CATEGORY_VALUE,
  toNoneAwareValue,
} from "./category-combobox-none";

const CATEGORY = "clh1abc0000xyz0000000abcd";

describe("category combobox — explicit no-category row", () => {
  test("no category selects the explicit row", () => {
    expect(toNoneAwareValue("")).toBe(NO_CATEGORY_VALUE);
    expect(toNoneAwareValue(undefined)).toBe(NO_CATEGORY_VALUE);
    expect(toNoneAwareValue(CATEGORY)).toBe(CATEGORY);
  });

  test("the row and the toggle-clear both report no category as empty", () => {
    expect(fromNoneAwareValue(NO_CATEGORY_VALUE)).toBe("");
    expect(fromNoneAwareValue("")).toBe("");
    expect(fromNoneAwareValue(CATEGORY)).toBe(CATEGORY);
  });
});
