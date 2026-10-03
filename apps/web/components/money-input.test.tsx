import { describe, expect, test } from "bun:test";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import common from "@/messages/es/common.json";
import { MoneyField } from "./money-input";

/**
 * The money field (#1470), rendered to static markup (ADR-0012: no DOM runner) in es. Parsing,
 * display and the ambiguous-shape reading are pure and covered in `lib/utils/money.test.ts`.
 */
function render(value: string): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="es" timeZone="UTC" messages={{ common }}>
      <MoneyField id="cost" label="Costo" value={value} onValueChange={() => {}} />
    </NextIntlClientProvider>,
  );
}

const inputOf = (html: string) => /<input[^>]*>/.exec(html)?.[0] ?? "";

describe("MoneyField", () => {
  test("is a labelled decimal text input, so locale separators are not rejected by the browser", () => {
    const html = render("1.234,56");
    expect(html).toContain('<label data-slot="field-label"');
    expect(html).toContain('for="cost"');
    const input = inputOf(html);
    expect(input).toContain('id="cost"');
    expect(input).toContain('type="text"');
    expect(input).toContain('inputMode="decimal"');
    expect(input).toContain('value="1.234,56"');
  });

  test("a valid prefilled amount is not flagged", () => {
    const html = render("1.500");
    expect(html).not.toContain('aria-invalid="');
    expect(html).not.toContain('data-invalid="');
    expect(html).not.toContain('role="alert"');
  });

  test("a prefilled amount that no longer reads in this locale shows why from the start", () => {
    // Saved while lazyit was in English, opened in Spanish: saving must not be a silent no-op.
    const html = render("1,234.56");
    expect(inputOf(html)).toContain('aria-invalid="true"');
    expect(html).toContain('data-invalid="true"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Ingresa un monto como 1.234,56.");
  });

  test("an empty field is not flagged and echoes nothing", () => {
    const html = render("");
    expect(html).not.toContain('aria-invalid="');
    expect(html).not.toContain("Leído como");
  });

  test("the reading echo waits for the operator to leave the field", () => {
    // "1.150" is the ambiguous shape, but a prefilled value is not echoed on first render.
    expect(render("1.150")).not.toContain("Leído como");
  });
});
