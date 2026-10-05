import { describe, expect, test } from "bun:test";
import { parseStatusChange } from "./asset-history-status";

describe("parseStatusChange", () => {
  test("an event between two bare statuses (the pre-ADR-0101 shape) has no labels", () => {
    expect(parseStatusChange({ from: "OPERATIONAL", to: "IN_MAINTENANCE" })).toEqual({
      from: { status: "OPERATIONAL", raw: "OPERATIONAL", label: null },
      to: { status: "IN_MAINTENANCE", raw: "IN_MAINTENANCE", label: null },
    });
  });

  test("label names ride along on either side, including a label-only change", () => {
    expect(
      parseStatusChange({
        from: "IN_STORAGE",
        to: "IN_STORAGE",
        fromLabel: { id: "cla", name: "Loaner pool" },
        toLabel: null,
      }),
    ).toEqual({
      from: { status: "IN_STORAGE", raw: "IN_STORAGE", label: "Loaner pool" },
      to: { status: "IN_STORAGE", raw: "IN_STORAGE", label: null },
    });
  });

  test("a malformed label reads as none; an unknown status is kept raw", () => {
    expect(
      parseStatusChange({ from: "GONE", to: "LOST", fromLabel: "x", toLabel: { name: 3 } }),
    ).toEqual({
      from: { status: null, raw: "GONE", label: null },
      to: { status: "LOST", raw: "LOST", label: null },
    });
  });

  test("a payload without both sides yields nothing", () => {
    expect(parseStatusChange({ from: "LOST" })).toBeNull();
    expect(parseStatusChange({})).toBeNull();
    expect(parseStatusChange(null)).toBeNull();
  });
});
