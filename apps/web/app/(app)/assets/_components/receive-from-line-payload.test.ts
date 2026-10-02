/**
 * Receiving against a purchase line (ADR-0099 §3.d of the UX proposal, #1475): the prefill a line gives the
 * Receive stock dialog, the quantity that follows the pasted serials, the explicit-override body, and the
 * over-receipt warning. Every body is parsed through `ReceiveFromLineSchema`, the real validator.
 */

import { describe, expect, test } from "bun:test";
import { ReceiveFromLineSchema } from "@lazyit/shared";
import {
  buildReceiveFromLinePayload,
  effectiveQuantity,
  lineReceivePrefill,
  overReceipt,
} from "./receive-stock-payload";

const MODEL = "clh1model0000000000000000";
const LOCATION = "clh1locat0000000000000000";

const PURCHASE = {
  invoiceDate: "2026-03-10T00:00:00.000Z",
  currency: "ARS",
  company: "Acme S.A.",
  deliveryLocationId: LOCATION,
};
const LINE = { assetModelId: MODEL, unitPrice: 141250000, warrantyMonths: 36, pendingQuantity: 3 };

describe("the prefill from a line", () => {
  test("takes model, cost, currency, company, location and every pending unit; status In storage", () => {
    const { values, dateSource } = lineReceivePrefill(PURCHASE, LINE, "2026-04-02", "en");
    expect(values).toEqual({
      modelId: MODEL,
      quantity: "3",
      status: "IN_STORAGE",
      locationId: LOCATION,
      company: "Acme S.A.",
      purchaseDate: "2026-03-10",
      purchaseCost: "1,412,500",
      purchaseCurrency: "ARS",
      warrantyEnd: "2029-03-10",
      notes: "",
      serials: "",
    });
    expect(dateSource).toBe("INVOICE");
  });

  test("without an invoice date the purchase date is today, never the order date, and the warranty follows", () => {
    const { values, dateSource } = lineReceivePrefill(
      { ...PURCHASE, invoiceDate: null },
      { ...LINE, warrantyMonths: 12 },
      "2026-04-02",
      "en",
    );
    expect(values.purchaseDate).toBe("2026-04-02");
    expect(values.warrantyEnd).toBe("2027-04-02");
    expect(dateSource).toBe("TODAY");
  });

  test("a line without a model, price or warranty leaves those blank, and the cost reads in the viewer's locale", () => {
    const { values } = lineReceivePrefill(
      { invoiceDate: null, currency: null, company: null, deliveryLocationId: null },
      { assetModelId: null, unitPrice: null, warrantyMonths: null, pendingQuantity: 0 },
      "2026-04-02",
      "es",
    );
    expect(values.modelId).toBe("");
    expect(values.purchaseCost).toBe("");
    expect(values.warrantyEnd).toBe("");
    expect(values.purchaseCurrency).toBe("");
    // Nothing pending (an over-receipt on purpose) still starts at one unit.
    expect(values.quantity).toBe("1");
    expect(lineReceivePrefill(PURCHASE, { ...LINE, unitPrice: 150050 }, "2026-04-02", "es").values.purchaseCost).toBe(
      "1.500,50",
    );
  });
});

describe("quantity follows the serials", () => {
  test("pasted serials set the quantity; an empty box keeps the typed one", () => {
    expect(effectiveQuantity("3", "PF1\n\n PF2 \n")).toBe(2);
    expect(effectiveQuantity("3", "  \n")).toBe(3);
    expect(effectiveQuantity("1", "A\nB\nC\nD\nE")).toBe(5);
  });
});

describe("the receive-from-line body", () => {
  const prefill = lineReceivePrefill(PURCHASE, LINE, "2026-04-02", "en").values;

  const fromPurchase = { locationId: LOCATION };

  test("sends the prefilled values explicitly, the cost with its label, and the serials with a matching quantity", () => {
    const body = buildReceiveFromLinePayload({ ...prefill, serials: "PF1\nPF2" }, "en", fromPurchase);
    expect(body).toEqual({
      quantity: 2,
      serials: ["PF1", "PF2"],
      status: "IN_STORAGE",
      modelId: MODEL,
      // Still the purchase's delivery location: left to the API, not sent.
      company: "Acme S.A.",
      purchaseDate: "2026-03-10T00:00:00.000Z",
      warrantyEnd: "2029-03-10T00:00:00.000Z",
      purchaseCost: 141250000,
      purchaseCurrency: "ARS",
    });
    expect(ReceiveFromLineSchema.safeParse(body).success).toBe(true);
  });

  test("a field the operator cleared is null — the units get no value, the purchase's is not brought back", () => {
    const body = buildReceiveFromLinePayload(
      { ...prefill, locationId: "", company: "  ", purchaseDate: "", warrantyEnd: "", purchaseCost: "" },
      "en",
      fromPurchase,
    );
    expect(body).toMatchObject({
      quantity: 3,
      locationId: null,
      company: null,
      purchaseDate: null,
      warrantyEnd: null,
      purchaseCost: null,
      // Cost and currency move together: no cost, no label.
      purchaseCurrency: null,
    });
    expect(body).not.toHaveProperty("serials");
    expect(ReceiveFromLineSchema.safeParse(body).success).toBe(true);
  });

  test("the location is sent only when the operator changed it, and null only when they cleared it", () => {
    const OTHER = "clh1other0000000000000000";
    expect(buildReceiveFromLinePayload(prefill, "en", fromPurchase)).not.toHaveProperty("locationId");
    expect(buildReceiveFromLinePayload({ ...prefill, locationId: OTHER }, "en", fromPurchase).locationId).toBe(OTHER);
    expect(buildReceiveFromLinePayload({ ...prefill, locationId: "" }, "en", fromPurchase).locationId).toBeNull();
    // A purchase with no delivery location and the field left blank: nothing to say.
    expect(buildReceiveFromLinePayload({ ...prefill, locationId: "" }, "en", { locationId: "" })).not.toHaveProperty(
      "locationId",
    );
  });

  test("an unreadable amount is refused by the schema, never sent as no cost", () => {
    const body = buildReceiveFromLinePayload({ ...prefill, purchaseCost: "12,34,5" }, "en");
    expect(ReceiveFromLineSchema.safeParse(body).success).toBe(false);
  });
});

describe("over-receipt (ADR-0099 §4: warn, never block)", () => {
  const line = { quantity: 4, cancelledQuantity: 0, receivedQuantity: 3 };

  test("receiving the pending unit is exact; one more is over, and the fix raises the line to the total", () => {
    expect(overReceipt(line, 1)).toEqual({ over: false, after: 4, raiseTo: 4 });
    expect(overReceipt(line, 2)).toEqual({ over: true, after: 5, raiseTo: 5 });
  });

  test("cancelled units count against what the line still expects", () => {
    expect(overReceipt({ quantity: 4, cancelledQuantity: 1, receivedQuantity: 3 }, 1)).toEqual({
      over: true,
      after: 4,
      raiseTo: 5,
    });
  });
});
