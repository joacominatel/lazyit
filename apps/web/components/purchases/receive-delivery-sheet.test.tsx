import { describe, expect, mock, test } from "bun:test";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { assetOutcome, type DeliveryOutcome } from "@/lib/purchases/receive-delivery";
import assets from "@/messages/en/assets.json";
import purchases from "@/messages/en/purchases.json";

mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => null,
}));
const { DeliveryOutcomes } = await import("./receive-delivery-sheet");

/**
 * The combined result of *Receive delivery* (#1497): every line reads on its own — received, partly received
 * with each failed unit and why, or not received with the request's error — and the delivery note's upload is
 * reported. Static markup (ADR-0012: no DOM runner); the outcomes themselves are `assetOutcome` and the
 * sheet's per-line loop.
 */
const LINES = [
  { id: "laptops", description: "Lenovo ThinkPad E14" },
  { id: "docks", description: "Dell WD19S dock" },
  { id: "toner", description: "Toner HP 26A" },
];

function render(outcomes: DeliveryOutcome[], note: "uploaded" | "failed" | null = null): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ assets, purchases }}>
      <DeliveryOutcomes lines={LINES} outcomes={outcomes} note={note} />
    </NextIntlClientProvider>,
  );
}

describe("the delivery result", () => {
  test("a partial delivery names each line's outcome and why each failed unit failed", () => {
    const html = render(
      [
        assetOutcome("laptops", { created: [{}, {}], failed: [{ index: 2, error: "Serial PF4A1X7 already used by LZ-0399" }], overReceived: false }),
        { lineId: "docks", kind: "ASSET", state: "error", message: "The line changed meanwhile" },
        { lineId: "toner", kind: "CONSUMABLE", state: "received", created: 6, overReceived: true },
      ],
      "uploaded",
    );
    expect(html).toContain("8 units received.");
    expect(html).toContain("2 lines need a look");
    expect(html).toContain("2 received · 1 couldn&#x27;t be created");
    expect(html).toContain("Unit 3");
    expect(html).toContain("Serial PF4A1X7 already used by LZ-0399");
    expect(html).toContain("Not received");
    expect(html).toContain("The line changed meanwhile");
    expect(html).toContain("6 units into stock");
    expect(html).toContain("over-received");
    expect(html).toContain("The delivery note was added to the purchase&#x27;s documents.");
  });

  test("when nothing was received it says so, and a failed note upload is a warning of its own", () => {
    const html = render(
      [assetOutcome("laptops", { created: [], failed: [{ index: 0, error: "duplicate" }], overReceived: false })],
      "failed",
    );
    expect(html).toContain("Nothing was received");
    expect(html).toContain("No unit could be created");
    expect(html).toContain("The delivery note couldn&#x27;t be uploaded");
  });
});
