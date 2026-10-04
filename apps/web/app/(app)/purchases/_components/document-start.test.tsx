import { describe, expect, test } from "bun:test";
import type { PurchaseExtractionStatus } from "@lazyit/shared";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import purchases from "@/messages/en/purchases.json";
import { DocumentDropStage, DocumentStartCard, type StartedDocument } from "./document-start";

const STATUS: PurchaseExtractionStatus = {
  available: true,
  reason: null,
  mediaTypes: ["application/pdf", "image/png"],
  maxBytes: 10 * 1024 * 1024,
  maxPages: 20,
  disclosure: "…",
};

const x = purchases.extraction.newFromDocument;
const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ purchases }}>
      {node}
    </NextIntlClientProvider>,
  );
}

function stage(started: StartedDocument | null): string {
  return render(<DocumentDropStage start={{ status: STATUS, started, start: () => {} }} />);
}

const card = (step: StartedDocument["step"]) =>
  render(<DocumentStartCard started={{ name: "Factura A 0003.pdf", size: 1_258_291, step }} />);

describe("the drop target (#1516)", () => {
  test("names the action, the types and the cap, and says the file goes to the AI provider", () => {
    const html = stage(null);
    expect(html).toContain(esc(x.dropTitle));
    expect(html).toContain("A PDF or an image, up to 10 MB.");
    expect(html).toContain("sends the file to your AI provider to read");
  });

  test("stays out of the way until a file is dragged over the page", () => {
    const html = stage(null);
    expect(html).toMatch(/aria-hidden="true"[^>]*data-state="idle"[^>]*class="[^"]*pointer-events-none[^"]*opacity-0/);
  });

  test("once a file is taken, the page shows its card instead of the target", () => {
    const html = stage({ name: "Factura A 0003.pdf", size: 1000, step: "create" });
    expect(html).toContain('data-state="starting"');
    expect(html).toContain('role="status"');
    expect(html).not.toContain(esc(x.dropTitle));
  });
});

describe("the landing card", () => {
  test("shows the document's name and size", () => {
    const html = card("create");
    expect(html).toContain('aria-label="Starting a purchase from Factura A 0003.pdf"');
    expect(html).toContain("Factura A 0003.pdf");
    expect(html).toContain("1.2 MB");
  });

  test("walks the steps in order, each resolving as it completes", () => {
    expect(card("create")).toMatch(
      /data-state="active" aria-current="step"[^>]*>.*Creating the purchase<\/li><li data-state="pending"[^>]*>.*Attaching the document<\/li><li data-state="pending"[^>]*>.*Opening the review/,
    );
    expect(card("attach")).toMatch(
      /data-state="done"[^>]*>.*Purchase created<\/li><li data-state="active" aria-current="step"[^>]*>.*Attaching the document/,
    );
    expect(card("open")).toMatch(
      /Purchase created<\/li>.*Document attached<\/li><li data-state="active" aria-current="step"[^>]*>.*Opening the review/,
    );
  });

  test("lands without moving under reduced motion: the transform is motion-safe only", () => {
    const html = card("create");
    expect(html).toContain("motion-safe:animate-rise-in");
    expect(html).not.toMatch(/(?<!:)animate-rise-in/);
    expect(stage(null)).not.toMatch(/(?<!:)scale-\[0\.98\]/);
  });
});
