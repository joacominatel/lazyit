import { describe, expect, test } from "bun:test";
import { classifyLink } from "./chat-links";

describe("classifyLink", () => {
  test("in-app paths are internal", () => {
    expect(classifyLink("/assets/a1", "MBP-042")).toEqual({ kind: "internal", href: "/assets/a1" });
  });

  test("protocol-relative and backslash tricks are text", () => {
    expect(classifyLink("//evil.example/x", "x")).toEqual({ kind: "text" });
    expect(classifyLink("/\\evil.example", "x")).toEqual({ kind: "text" });
  });

  test("explicit external links show their host", () => {
    expect(classifyLink("https://docs.example.com/a?b=1", "the docs")).toEqual({
      kind: "external",
      href: "https://docs.example.com/a?b=1",
      host: "docs.example.com",
    });
  });

  test("bare, auto-linked URLs are never links", () => {
    expect(classifyLink("https://evil.example/?q=secret", "https://evil.example/?q=secret")).toEqual({
      kind: "text",
    });
    expect(classifyLink("http://www.evil.example", "www.evil.example")).toEqual({ kind: "text" });
  });

  test("other schemes and credentials in the URL are text", () => {
    expect(classifyLink("javascript:alert(1)", "click")).toEqual({ kind: "text" });
    expect(classifyLink("data:text/html,<b>", "click")).toEqual({ kind: "text" });
    expect(classifyLink("mailto:a@b.c", "mail")).toEqual({ kind: "text" });
    expect(classifyLink("https://user:pw@evil.example", "x")).toEqual({ kind: "text" });
    expect(classifyLink(undefined, "x")).toEqual({ kind: "text" });
  });
});
