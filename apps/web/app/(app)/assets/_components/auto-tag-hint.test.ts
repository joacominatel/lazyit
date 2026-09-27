import { describe, expect, test } from "bun:test";
import type { AssetTagSchemeSummary } from "@lazyit/shared";
import { autoTagHintFrom } from "./auto-tag-hint";

const ON: AssetTagSchemeSummary = {
  enabled: true,
  prefix: "LZ-",
  suffix: null,
  width: 4,
  nextTag: "LZ-1001",
  nextTagNumber: 1001,
  exhausted: false,
};

describe("autoTagHintFrom", () => {
  test("creating under an enabled scheme shows the server's next tag", () => {
    expect(autoTagHintFrom(ON, false)).toBe("LZ-1001");
  });

  test("never on edit", () => {
    expect(autoTagHintFrom(ON, true)).toBeUndefined();
  });

  test("nothing when the scheme is off or the summary has not resolved", () => {
    expect(autoTagHintFrom({ ...ON, enabled: false }, false)).toBeUndefined();
    expect(autoTagHintFrom(undefined, false)).toBeUndefined();
  });

  test("nothing when the sequence is exhausted", () => {
    expect(
      autoTagHintFrom(
        { ...ON, nextTag: null, nextTagNumber: null, exhausted: true },
        false,
      ),
    ).toBeUndefined();
  });
});
