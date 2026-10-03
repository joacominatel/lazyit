import { describe, expect, test } from "bun:test";
import { composerTextWithPrefill } from "./prefill";

describe("composerTextWithPrefill (#1478)", () => {
  test("an empty box takes the prepared message as is", () => {
    expect(composerTextWithPrefill("Read the document", "", 100)).toBe("Read the document");
    expect(composerTextWithPrefill("Read the document", "   \n", 100)).toBe("Read the document");
  });

  test("a draft is kept, after the prepared message", () => {
    expect(composerTextWithPrefill("Read the document", " and use HQ ", 100)).toBe(
      "Read the document\n\nand use HQ",
    );
  });

  test("the result stays within the prompt limit", () => {
    expect(composerTextWithPrefill("abc", "defgh", 6)).toBe("abc\n\nd");
  });
});
