import { describe, expect, test } from "bun:test";
import type { DataExportResource } from "@lazyit/shared";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import exportMessages from "@/messages/en/export.json";
import { ExportButtonView } from "./export-button";

function render(total: number | undefined, resource?: DataExportResource): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ export: exportMessages }}>
      <ExportButtonView
        path="/assets/export"
        params={new URLSearchParams()}
        total={total}
        filename="assets"
        resource={resource}
      />
    </NextIntlClientProvider>,
  );
}

function button(html: string): string {
  return /<button[^>]*>/.exec(html)?.[0] ?? "";
}

describe("ExportButton", () => {
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

  test("stays a single CSV button for a resource without Excel, or when none is named", () => {
    for (const html of [render(3), render(3, "USERS"), render(3, "PENDING_UNITS")]) {
      expect(html).toContain("Export CSV");
      expect(button(html)).not.toContain("aria-haspopup");
    }
  });

  test("offers a CSV / Excel menu on the assets and purchases exports", () => {
    for (const resource of ["ASSETS", "PURCHASE_ORDERS"] as const) {
      const html = render(3, resource);
      expect(button(html)).toContain('aria-haspopup="menu"');
      expect(html).not.toContain("Export CSV");
      expect(button(html)).toContain("as a CSV or an Excel workbook");
    }
  });

  test("the menu trigger keeps the same disabled rule", () => {
    expect(button(render(undefined, "ASSETS"))).toContain('disabled=""');
    expect(button(render(0, "PURCHASE_ORDERS"))).toContain('disabled=""');
    expect(button(render(250_000, "ASSETS"))).not.toContain('disabled=""');
  });
});
