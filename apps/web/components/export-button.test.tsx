import { describe, expect, test } from "bun:test";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import exportMessages from "@/messages/en/export.json";
import { ExportButtonView } from "./export-button";

function render(total: number | undefined, disabledReason?: string): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ export: exportMessages }}>
      <ExportButtonView
        path="/assets/export"
        params={new URLSearchParams()}
        total={total}
        filename="assets"
        disabledReason={disabledReason}
      />
    </NextIntlClientProvider>,
  );
}

function button(html: string): string {
  return /<button[^>]*>/.exec(html)?.[0] ?? "";
}

describe("ExportButton", () => {
  test("is disabled with its reason when the screen narrows rows the export cannot", () => {
    const html = render(3, "Clear the filters to export");
    expect(button(html)).toContain('disabled=""');
    expect(button(html)).toContain('title="Clear the filters to export"');
  });

  test("is disabled while the list total loads and when nothing matches", () => {
    expect(button(render(undefined))).toContain('disabled=""');
    expect(button(render(0))).toContain('disabled=""');
  });

  test("is enabled when rows match, the over-cap case included (it warns on click)", () => {
    expect(button(render(3))).not.toContain('disabled=""');
    expect(button(render(250_000))).not.toContain('disabled=""');
  });

  test("says what it exports", () => {
    const html = render(3);
    expect(html).toContain("Export CSV");
    expect(button(html)).toContain("every row matching the current filters");
  });
});
