import { describe, expect, test } from "bun:test";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import messages from "@/messages/en/ai.json";
import { AiWebSources } from "./ai-web-sources";

/**
 * Web search sources under an answer (#1389), rendered to static markup (ADR-0012: no DOM runner): only
 * http(s) links, opened in a new tab without opener or referrer, titles as plain text.
 */
function render(sources: { url: string; title: string | null }[]): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{ ai: messages }} timeZone="UTC">
      <AiWebSources part={{ type: "sources", sources }} />
    </NextIntlClientProvider>,
  );
}

describe("AiWebSources", () => {
  test("an http(s) source is a new-tab link with noopener noreferrer", () => {
    const html = render([{ url: "https://www.easyredmine.com/docs", title: "Easy Redmine docs" }]);
    expect(html).toContain('href="https://www.easyredmine.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Easy Redmine docs");
    expect(html).toContain("Sources from the web");
  });

  test("another scheme never becomes a link", () => {
    const html = render([
      { url: "javascript:alert(1)", title: "evil" },
      { url: "data:text/html,<b>x</b>", title: "data" },
      { url: "https://ok.example/", title: "ok" },
    ]);
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text");
    expect(html).toContain('href="https://ok.example/"');
  });

  test("a title is plain text, never HTML", () => {
    const html = render([{ url: "https://ok.example/", title: '<img src=x onerror="alert(1)">' }]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  test("nothing at all when no source is usable", () => {
    expect(render([{ url: "javascript:alert(1)", title: "evil" }])).toBe("");
  });
});
