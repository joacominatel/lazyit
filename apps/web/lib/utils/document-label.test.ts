import { describe, expect, test } from "bun:test";
import { UpdateAttachmentSchema } from "@lazyit/shared";
import { labelFits, labelPatch, uploadLabel } from "./document-label";

describe("document type labels (#1476)", () => {
  test("an upload carries the trimmed label, and none at all when blank", () => {
    expect(uploadLabel("  Invoice ")).toBe("Invoice");
    expect(uploadLabel("   ")).toBeUndefined();
  });

  test("an emptied field clears the label with null", () => {
    expect(labelPatch("  ", "Invoice")).toEqual({ label: null });
    expect(UpdateAttachmentSchema.parse({ label: null })).toEqual({ label: null });
  });

  test("a new or changed label is sent trimmed", () => {
    expect(labelPatch(" Delivery note ", null)).toEqual({ label: "Delivery note" });
    expect(labelPatch("Quote", "Invoice")).toEqual({ label: "Quote" });
  });

  test("an unchanged label sends nothing — an older row without the field reads as no label", () => {
    expect(labelPatch("Invoice ", "Invoice")).toBeNull();
    expect(labelPatch("", undefined)).toBeNull();
    expect(labelPatch("", null)).toBeNull();
  });

  test("a label past the stored length is refused on the field", () => {
    expect(labelFits("x".repeat(100))).toBe(true);
    expect(labelFits("x".repeat(101))).toBe(false);
  });
});
