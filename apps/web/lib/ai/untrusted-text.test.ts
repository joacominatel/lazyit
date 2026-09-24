import { describe, expect, test } from "bun:test";
import { plainText, stripUntrusted } from "./untrusted-text";

describe("stripUntrusted", () => {
  test("removes the wrapper tags and keeps the text as text", () => {
    expect(stripUntrusted("Note: <untrusted_content>hello <b>x</b></untrusted_content>")).toEqual({
      text: "Note: hello <b>x</b>",
      untrusted: true,
    });
  });

  test("handles attributes, case and several blocks", () => {
    expect(
      plainText('<UNTRUSTED_CONTENT source="article:1">a</Untrusted_Content> and <untrusted_content>b</untrusted_content>'),
    ).toBe("a and b");
  });

  test("leaves other text alone", () => {
    expect(stripUntrusted("plain <untrusted> text")).toEqual({
      text: "plain <untrusted> text",
      untrusted: false,
    });
  });
});
