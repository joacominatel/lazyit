import { describe, expect, test } from "bun:test";
import { categoryIdForPayload } from "./asset-model-category-payload";

const LAPTOPS = "clh1abc0000xyz0000000abcd";
const PHONES = "clh1abc0000xyz0000000efgh";

describe("categoryIdForPayload", () => {
  test("a picked category is sent as its id, on create and on edit", () => {
    expect(categoryIdForPayload(LAPTOPS, undefined)).toBe(LAPTOPS);
    expect(categoryIdForPayload(PHONES, LAPTOPS)).toBe(PHONES);
  });

  test("no category on edit of a categorized model sends null (clears it)", () => {
    expect(categoryIdForPayload("", LAPTOPS)).toBeNull();
  });

  test("no category is omitted on create and when the model has none", () => {
    expect(categoryIdForPayload("", undefined)).toBeUndefined();
    expect(categoryIdForPayload("", null)).toBeUndefined();
  });
});
