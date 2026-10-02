import { describe, expect, test } from "bun:test";
import { UpdateAttachmentSchema } from "@lazyit/shared";
import { labelFits, labelPatch, planUpload, uploadLabel } from "./document-label";

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

describe("an upload consumes the typed type only when a file goes up (#1476 review)", () => {
  const pdf = { name: "fc.pdf", size: 1_000, type: "application/pdf" };
  const svg = { name: "x.svg", size: 1_000, type: "image/svg+xml" };
  const huge = { name: "big.pdf", size: 26 * 1024 * 1024, type: "application/pdf" };

  test("every file refused: the label stays in its field", () => {
    const plan = planUpload([svg, huge], "Invoice");
    expect(plan.accepted).toEqual([]);
    expect(plan.refused.map((r) => r.reason)).toEqual(["invalidType", "tooLarge"]);
    expect(plan.consumeLabel).toBe(false);
  });

  test("one file passes: it carries the label, and the label is consumed", () => {
    const plan = planUpload([svg, pdf], " Invoice ");
    expect(plan.accepted).toEqual([pdf]);
    expect(plan).toMatchObject({ label: "Invoice", consumeLabel: true });
  });

  test("a file the browser gives no type passes — the server sniffs it", () => {
    expect(planUpload([{ name: "scan", size: 10, type: "" }], "").accepted).toHaveLength(1);
  });
});
