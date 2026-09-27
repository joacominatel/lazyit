import { describe, expect, test } from "bun:test";
import { webSourceLink, webSourceLinks } from "./web-sources";

describe("web search sources (#1389)", () => {
  test("an http(s) source becomes a link labelled with its title, or its host", () => {
    expect(webSourceLink({ url: "https://www.easyredmine.com/docs", title: "  Easy\nRedmine docs " })).toEqual({
      href: "https://www.easyredmine.com/docs",
      label: "Easy Redmine docs",
      host: "easyredmine.com",
    });
    expect(webSourceLink({ url: "http://example.org/a", title: null })?.label).toBe("example.org");
  });

  test("never a link for another scheme, a relative URL or credentials in the URL", () => {
    for (const url of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "data:text/html,<script>x</script>",
      "vbscript:x",
      "file:///etc/passwd",
      "/relative",
      "//example.com",
      "https://user:pass@example.com",
      "not a url",
    ]) {
      expect(webSourceLink({ url, title: "x" })).toBeNull();
    }
  });

  test("the list drops unsafe entries and duplicates", () => {
    expect(
      webSourceLinks([
        { url: "https://a.example/", title: "A" },
        { url: "javascript:alert(1)", title: "evil" },
        { url: "https://a.example/", title: "A again" },
      ]).map((l) => l.href),
    ).toEqual(["https://a.example/"]);
  });
});
