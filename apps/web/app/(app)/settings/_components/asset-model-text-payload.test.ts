import { describe, expect, test } from "bun:test";
import { clearableTextForPayload } from "./asset-model-text-payload";

describe("clearableTextForPayload", () => {
  test("entered text is sent trimmed, on create and on edit", () => {
    expect(clearableTextForPayload("  LAT-7440 ", undefined)).toBe("LAT-7440");
    expect(clearableTextForPayload("LAT-7450", "LAT-7440")).toBe("LAT-7450");
    expect(clearableTextForPayload("Business laptop", null)).toBe("Business laptop");
  });

  test("an emptied field on edit of a model that has a value sends null (clears it)", () => {
    expect(clearableTextForPayload("", "LAT-7440")).toBeNull();
    expect(clearableTextForPayload("   ", "Business laptop")).toBeNull();
  });

  test("an empty field is omitted on create and when the model has none", () => {
    expect(clearableTextForPayload("", undefined)).toBeUndefined();
    expect(clearableTextForPayload("  ", undefined)).toBeUndefined();
    expect(clearableTextForPayload("", null)).toBeUndefined();
    expect(clearableTextForPayload("", "")).toBeUndefined();
  });

  test("never returns an empty string", () => {
    for (const entered of ["", " ", "\t\n"]) {
      for (const current of [undefined, null, "", "x"]) {
        expect(clearableTextForPayload(entered, current)).not.toBe("");
      }
    }
  });
});
