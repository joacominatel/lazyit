import { describe, expect, test } from "bun:test";
import type { PurchaseLinkPreviewAsset } from "@lazyit/shared";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { linkSubmitOutcome } from "@/lib/purchases/link-apply";
import purchases from "@/messages/en/purchases.json";
import { LinkResultView } from "./link-assets-dialog";

/**
 * The link dialog's result step (#1475 review): a partial link closes nothing — the dialog keeps the
 * outcome captured at submit and renders it, naming each refused asset with its reason. Static markup
 * (ADR-0012: no DOM runner); the state transition itself is `linkSubmitOutcome`.
 */
const A = "ck0000000000000000000000a";
const B = "ck0000000000000000000000b";

function previewAsset(id: string, name: string, assetTag: string): PurchaseLinkPreviewAsset {
  const same = { current: null, purchase: null, action: "SAME" as const };
  return {
    assetId: id,
    name,
    assetTag,
    linkState: "NONE",
    linkedLineId: null,
    linkedPurchaseOrderId: null,
    fields: {
      purchaseDate: same,
      purchaseCost: { current: { amount: null, currency: null }, purchase: null, action: "SAME" },
      warrantyEnd: same,
      company: same,
      modelId: same,
    },
  };
}

function renderResult(failed: { assetId: string; reason: string; error: string }[], linked: number): string {
  const outcome = linkSubmitOutcome(
    { linked: Array.from({ length: linked }, () => ({})), failed },
    [previewAsset(A, "ThinkPad E14", "LZ-0411"), previewAsset(B, "ThinkPad E14", "LZ-0412")],
  );
  if (outcome.kind !== "result") throw new Error("expected the result step");
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ purchases }}>
      <LinkResultView snapshot={outcome.snapshot} purchaseId="ck00000000000000purchase1" onDone={() => {}} />
    </NextIntlClientProvider>,
  );
}

describe("the link result step", () => {
  test("a partial failure says how many were linked and why each other one was not", () => {
    const html = renderResult([{ assetId: B, reason: "LINKED_ELSEWHERE", error: "on another line" }], 1);
    expect(html).toContain("1 asset linked.");
    expect(html).toContain("LZ-0412 · ThinkPad E14");
    expect(html).toContain("On another purchase — tick “Move here” to move it");
    expect(html).toContain('href="/purchases/ck00000000000000purchase1"');
  });

  test("when nothing was linked it says so, and a reason this build does not know prints the API's text", () => {
    const html = renderResult([{ assetId: A, reason: "SOMETHING_NEW", error: "the API says why" }], 0);
    expect(html).toContain("No asset was linked");
    expect(html).toContain("the API says why");
  });
});
