import { describe, expect, it } from "bun:test";
import {
  applyCustomShortcutToIgnored,
  type ColumnChoice,
  CUSTOM,
  customChoiceFromHeader,
  IGNORE,
} from "./mapping-shortcuts";

describe("customChoiceFromHeader", () => {
  it("seeds target=CUSTOM with the header as the customName", () => {
    expect(customChoiceFromHeader("Serial Number")).toEqual({
      target: CUSTOM,
      customName: "Serial Number",
    });
  });

  it("clamps an oversized header to the 100-char customName cap (mapping.ts:67)", () => {
    const header = "x".repeat(150);
    const choice = customChoiceFromHeader(header);
    expect(choice.customName).toHaveLength(100);
    expect(choice.customName).toBe("x".repeat(100));
  });
});

describe("applyCustomShortcutToIgnored", () => {
  it("converts only the ignored columns, leaving already-mapped ones untouched", () => {
    const headers = ["Status", "Notes", "RAM"];
    const choices: Record<string, ColumnChoice> = {
      Status: { target: "asset:status", customName: "" },
      Notes: { target: IGNORE, customName: "" },
      RAM: { target: IGNORE, customName: "" },
    };

    const next = applyCustomShortcutToIgnored(headers, choices);

    expect(next.Status).toEqual({ target: "asset:status", customName: "" });
    expect(next.Notes).toEqual({ target: CUSTOM, customName: "Notes" });
    expect(next.RAM).toEqual({ target: CUSTOM, customName: "RAM" });
  });

  it("does not clobber a column already converted to custom with an edited name", () => {
    const headers = ["Notes"];
    const choices: Record<string, ColumnChoice> = {
      Notes: { target: CUSTOM, customName: "Free text" },
    };

    expect(applyCustomShortcutToIgnored(headers, choices)).toEqual(choices);
  });

  it("is a no-op when nothing is ignored", () => {
    const headers = ["Status"];
    const choices: Record<string, ColumnChoice> = {
      Status: { target: "asset:status", customName: "" },
    };

    expect(applyCustomShortcutToIgnored(headers, choices)).toEqual(choices);
  });
});
