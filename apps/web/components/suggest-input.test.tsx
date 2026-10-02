import { describe, expect, test } from "bun:test";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import common from "@/messages/en/common.json";
import { SuggestInput } from "./suggest-input";

/**
 * Smart entry (#1470), rendered to static markup (ADR-0012: no DOM runner): the accessible shape of
 * the closed field and the non-blocking near-duplicate hint. Ranking, normalization and the keyboard
 * model are pure and covered in `lib/utils/suggest.test.ts`.
 */
function render(node: React.ReactNode, locale = "en"): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} timeZone="UTC" messages={{ common }}>
      {node}
    </NextIntlClientProvider>,
  );
}

const companies = () => [{ value: "Dell", count: 142 }, { value: "Lenovo" }];

describe("SuggestInput", () => {
  test("is a labelled-by-id, collapsed ARIA combobox that never autocompletes natively", () => {
    const html = render(
      <SuggestInput
        id="company"
        value=""
        onValueChange={() => {}}
        source={companies}
        recentKey="test.company"
      />,
    );
    const input = /<input[^>]*>/.exec(html)?.[0] ?? "";
    expect(input).toContain('id="company"');
    expect(input).toContain('role="combobox"');
    expect(input).toContain('aria-autocomplete="list"');
    expect(input).toContain('aria-expanded="false"');
    expect(input).toContain('autoComplete="off"');
    expect(input).not.toContain("aria-controls");
  });

  test("offers the existing spelling of a near-duplicate without replacing the text", () => {
    const html = render(
      <SuggestInput
        id="company"
        value="DELL INC."
        onValueChange={() => {}}
        source={companies}
        recentKey="test.company"
      />,
    );
    expect(html).toContain('value="DELL INC."');
    expect(html).toContain("Looks like an existing value: “Dell”.");
    expect(html).toContain("Used 142 times.");
    expect(html).toContain(">Use “Dell”</button>");
    expect(html).toMatch(/aria-describedby="company-suggest-hint"/);
  });

  test("stays quiet for a new value or an exact existing one", () => {
    for (const value of ["Acer", "Dell"]) {
      const html = render(
        <SuggestInput
          id="company"
          value={value}
          onValueChange={() => {}}
          source={companies}
          recentKey="test.company"
        />,
      );
      expect(html).not.toContain("Looks like an existing value");
      expect(html).not.toContain("<button");
    }
  });
});
