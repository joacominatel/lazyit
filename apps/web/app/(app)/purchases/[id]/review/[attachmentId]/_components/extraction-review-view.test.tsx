import { describe, expect, mock, test } from "bun:test";
import type { PurchaseExtractionDraft, PurchaseOrderDetail } from "@lazyit/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import common from "@/messages/en/common.json";
import purchases from "@/messages/en/purchases.json";
import { buildReview } from "@/lib/purchases/extraction-review";

mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  usePathname: () => "/purchases/p/review/a",
}));
const { ReviewForm } = await import("./extraction-review-view");
const { DocumentPreview } = await import("./document-preview");

/**
 * The extraction review (#1477), rendered to static markup (ADR-0012: no DOM runner): what was read is in
 * the page next to each value, a value not read says so and stays blank, the API's flags are counted, the
 * matched supplier says how it was matched, and the totals check names the gap. Nothing here saves — the
 * payload and the diff are `extraction-review.test.ts`.
 */
const blank = { value: null, evidence: null };
const read = <T,>(value: T, text: string) => ({ value, evidence: { text, page: 1 } });

const draft: PurchaseExtractionDraft = {
  extractionId: "ext_1",
  purchaseOrderId: "ckpurchase000000000000000",
  attachmentId: "ckattachment0000000000000",
  header: {
    supplierName: read("COMPUMUNDO S.A.", "COMPUMUNDO S.A."),
    supplierTaxId: read("30-71234567-9", "CUIT 30-71234567-9"),
    reference: read("OC 4471", "OC 4471"),
    currency: read("ARS", "$"),
    orderDate: blank,
    invoiceNumbers: blank,
    invoiceDate: blank,
  },
  lines: [
    {
      kind: "ASSET",
      description: read("NB LEN E14 G5", "NB LEN E14 G5"),
      manufacturerText: blank,
      modelText: blank,
      quantity: blank,
      unitPrice: read(141250000, "1.412.500,00"),
      lineTotal: blank,
      warrantyMonths: blank,
    },
  ],
  totals: { linesTotal: null, incompleteLines: 1, net: read(565000000, "5.650.000,00"), tax: blank, gross: blank },
  matches: { supplier: { id: "cksupplier000000000000000", name: "Compumundo", by: "TAX_ID" }, lineModels: [null] },
  warnings: [{ code: "CURRENCY_AMBIGUOUS", path: "header.currency" }],
};

const purchase = {
  id: "ckpurchase000000000000000",
  supplierId: null,
  supplier: null,
  reference: "OC 4470",
  status: "ORDERED",
  currency: null,
  orderDate: null,
  expectedDate: null,
  deliveryLocationId: null,
  company: null,
  invoiceNumbers: null,
  invoiceDate: null,
  notes: null,
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
  deletedAt: null,
  lines: [],
  totals: [],
  receipt: null,
} as unknown as PurchaseOrderDetail;

function render(): string {
  const review = buildReview(
    draft,
    purchase,
    { originalName: "factura.pdf", createdAt: "2026-03-05T00:00:00.000Z", count: 1 },
    "en",
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ purchases, common }}>
        <ReviewForm purchase={purchase} draft={draft} review={review} onChange={() => {}} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const x = purchases.extraction;
const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

describe("the extraction review", () => {
  const html = render();

  test("what was read, with its page, is in the page next to the value", () => {
    expect(html).toContain("Read “OC 4471” · page 1");
    expect(html).toContain("Read “1.412.500,00” · page 1");
  });

  test("a value not read stays blank and says so; a new line asks for its quantity", () => {
    expect(html).toContain(esc(x.notRead));
    expect(html).toContain(esc(x.quantityNeeded));
  });

  test("the flags are counted and spelled out where they apply", () => {
    expect(html).toContain("1 to check");
    expect(html).toContain(esc(x.warnings.CURRENCY_AMBIGUOUS));
  });

  test("a replacement is offered unticked, a fill ticked", () => {
    // Reference OC 4470 → OC 4471 is a replacement; the currency fills an empty field.
    expect(html).toMatch(/aria-label="Apply Reference"[^>]*data-state="unchecked"|data-state="unchecked"[^>]*aria-label="Apply Reference"/);
    expect(html).toMatch(/aria-label="Apply Currency"[^>]*data-state="checked"|data-state="checked"[^>]*aria-label="Apply Currency"/);
    expect(html).toContain("Now: OC 4470");
  });

  test("the supplier says how it was matched, and offers creating the one as read", () => {
    expect(html).toContain(esc(x.supplierMatchedTaxId));
    expect(html).toContain("Create “COMPUMUNDO S.A.”");
  });

  test("the totals check names the gap and the line without a quantity", () => {
    expect(html).toContain("1 line has no quantity or price");
  });

  test("nothing is saved until Save, and the page says so", () => {
    expect(html).toContain(esc(x.saveNote));
  });

  test("while a value cannot be sent, Save says to fix it instead of counting changes", () => {
    // The new line's quantity was not read, so the line cannot be added as it is.
    expect(html).toContain(esc(x.saveFix));
    expect(html).not.toContain("Save 0 changes");
  });
});

describe("the document preview", () => {
  test("a PDF is never framed (the CSP keeps frame-src 'none'): a card that opens it in a new tab", () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ purchases, common }}>
        <DocumentPreview
          purchaseId="ckpurchase000000000000000"
          attachment={{
            id: "ckattachment0000000000000",
            entityType: "PURCHASE_ORDER",
            entityId: "ckpurchase000000000000000",
            sha256: "0".repeat(64),
            byteSize: 1000,
            mimeType: "application/pdf",
            originalName: "factura.pdf",
            uploadedById: null,
            label: null,
            createdAt: "2026-03-01T00:00:00.000Z",
            updatedAt: "2026-03-01T00:00:00.000Z",
          }}
        />
      </NextIntlClientProvider>,
    );
    expect(html).not.toMatch(/<(iframe|object|embed)\b/);
    expect(html).toContain(esc(x.preview.pdfHelp));
    expect(html).toContain(esc(x.preview.openTab));
  });
});
