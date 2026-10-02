import { describe, expect, test } from "bun:test";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import common from "@/messages/es/common.json";
import { MoneyInput } from "./money-input";

/**
 * The money input (#1470), rendered to static markup (ADR-0012: no DOM runner). Parsing and display
 * are pure and covered in `lib/utils/money.test.ts`.
 */
function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="es" timeZone="UTC" messages={{ common }}>
      {node}
    </NextIntlClientProvider>,
  );
}

describe("MoneyInput", () => {
  test("is a decimal text input, so locale separators are not rejected by the browser", () => {
    const html = render(<MoneyInput id="cost" value="1.234,56" onValueChange={() => {}} />);
    const input = /<input[^>]*>/.exec(html)?.[0] ?? "";
    expect(input).toContain('type="text"');
    expect(input).toContain('inputMode="decimal"');
    expect(input).toContain('value="1.234,56"');
  });

  test("never flags an amount while it is being typed", () => {
    // "1,234.56" is refused in es, but only once the field is left.
    const html = render(<MoneyInput id="cost" value="1,234.56" onValueChange={() => {}} />);
    expect(html).not.toContain('aria-invalid="');
    expect(html).not.toContain('role="alert"');
  });
});
