import { describe, expect, test } from "bun:test";
import { referenceDuplicate } from "./reference";

const purchases = [
  { id: "p1", reference: "OC 0001-00004512" },
  { id: "p2", reference: "OC 0001-000045120" },
  { id: "p3", reference: null },
];

describe("referenceDuplicate (ADR-0099 §6: a hint, never a refusal)", () => {
  test("matches the exact reference, trimmed and ignoring case", () => {
    expect(referenceDuplicate(" oc 0001-00004512 ", purchases)?.id).toBe("p1");
  });

  test("a reference that only contains the typed text is not a duplicate", () => {
    expect(referenceDuplicate("OC 0001-0000451", purchases)).toBeNull();
  });

  test("the purchase being edited is not its own duplicate; blank never matches", () => {
    expect(referenceDuplicate("OC 0001-00004512", purchases, "p1")).toBeNull();
    expect(referenceDuplicate("  ", purchases)).toBeNull();
  });
});
