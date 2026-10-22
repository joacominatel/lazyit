/**
 * *Receive delivery* across several lines (#1497): which lines the sheet offers, how a row's count follows its
 * serials, the shared prefill, the per-line bodies (parsed by the real schemas inside `buildDeliveryPlan`) and
 * how the per-line outcomes read together.
 */

import { describe, expect, test } from "bun:test";
import type { PurchaseOrderLine } from "@lazyit/shared";
import {
  addScannedSerial,
  assetOutcome,
  buildDeliveryPlan,
  DELIVERY_NOTE_ACCEPT,
  deliveryLines,
  deliveryPrefill,
  deliveryUnits,
  type DeliveryRow,
  initialRow,
  rowQuantity,
  setRowQuantity,
  setRowSerials,
  stepRow,
  summarizeDelivery,
} from "./receive-delivery";

const PURCHASE_ID = "clh1purch0000000000000000";
const MODEL = "clh1model0000000000000000";
const OTHER_MODEL = "clh1model1111111111111111";
const LOCATION = "clh1locat0000000000000000";
const OTHER_LOCATION = "clh1locat1111111111111111";
const CONSUMABLE = "clh1consu0000000000000000";
const STATUS_LABEL = "clh1label0000000000000000";

function line(overrides: Partial<PurchaseOrderLine> & Pick<PurchaseOrderLine, "id" | "kind">): PurchaseOrderLine {
  return {
    purchaseOrderId: PURCHASE_ID,
    position: 0,
    description: "Lenovo ThinkPad E14",
    manufacturerText: null,
    modelText: null,
    assetModelId: null,
    consumableId: null,
    applicationId: null,
    quantity: 4,
    unitPrice: null,
    cancelledQuantity: 0,
    warrantyMonths: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    deletedAt: null,
    receivedQuantity: 0,
    pendingQuantity: 4,
    receiptState: "PENDING",
    lineTotal: null,
    ...overrides,
  } as PurchaseOrderLine;
}

const LAPTOPS = line({
  id: "clh1linea0000000000000000",
  kind: "ASSET",
  assetModelId: MODEL,
  unitPrice: 141250000,
  warrantyMonths: 36,
});
const DOCKS = line({ id: "clh1lineb0000000000000000", kind: "ASSET", description: "Dell WD19S dock", position: 1 });
const TONER = line({
  id: "clh1linec0000000000000000",
  kind: "CONSUMABLE",
  description: "Toner HP 26A",
  consumableId: CONSUMABLE,
  position: 2,
  quantity: 10,
  pendingQuantity: 10,
});
const SEATS = line({ id: "clh1lined0000000000000000", kind: "LICENSE", description: "M365 seats", position: 3 });
const FREIGHT = line({ id: "clh1linee0000000000000000", kind: "OTHER", description: "Freight", position: 4 });
const DONE = line({ id: "clh1linef0000000000000000", kind: "ASSET", pendingQuantity: 0, receivedQuantity: 4 });

const PURCHASE = {
  invoiceDate: "2026-03-10T00:00:00.000Z",
  currency: "ARS",
  company: "Acme S.A.",
  deliveryLocationId: LOCATION,
};

const ROW: DeliveryRow = { quantity: 0, serials: "", modelId: "", consumableId: "" };

describe("the lines a delivery offers", () => {
  const all = [LAPTOPS, DOCKS, TONER, SEATS, FREIGHT, DONE];

  test("asset and consumable lines still waiting for units, in order — never license, other or done lines", () => {
    expect(deliveryLines(all, { assets: true, stock: true }).map((l) => l.id)).toEqual([
      LAPTOPS.id,
      DOCKS.id,
      TONER.id,
    ]);
  });

  test("only the kinds the viewer may receive", () => {
    expect(deliveryLines(all, { assets: true, stock: false }).map((l) => l.id)).toEqual([LAPTOPS.id, DOCKS.id]);
    expect(deliveryLines(all, { assets: false, stock: true }).map((l) => l.id)).toEqual([TONER.id]);
    expect(deliveryLines(all, { assets: false, stock: false })).toEqual([]);
  });

  test("a kind a newer build writes is never taken for an asset line", () => {
    expect(deliveryLines([line({ id: "clh1lineg0000000000000000", kind: "SERVICE" })], { assets: true, stock: true }))
      .toEqual([]);
  });
});

describe("a row's count", () => {
  test("starts at zero, with the line's mapping", () => {
    expect(initialRow(LAPTOPS)).toEqual({ quantity: 0, serials: "", modelId: MODEL, consumableId: "" });
    expect(initialRow(TONER)).toEqual({ quantity: 0, serials: "", modelId: "", consumableId: CONSUMABLE });
  });

  test("the stepper stays between 0 and the kind's bound", () => {
    expect(stepRow(ROW, "ASSET", -1).quantity).toBe(0);
    expect(stepRow(stepRow(ROW, "ASSET", 1), "ASSET", 1).quantity).toBe(2);
    expect(setRowQuantity(ROW, "ASSET", 999).quantity).toBe(200);
    expect(setRowQuantity(ROW, "CONSUMABLE", 999).quantity).toBe(999);
    expect(setRowQuantity(ROW, "ASSET", Number.NaN).quantity).toBe(0);
    expect(setRowQuantity(ROW, "ASSET", 2.7).quantity).toBe(2);
  });

  test("pasted serials set the count; emptying the box keeps the last count", () => {
    const pasted = setRowSerials({ ...ROW, quantity: 1 }, "PF1\n\n PF2 \nPF3\n");
    expect(pasted.quantity).toBe(3);
    expect(rowQuantity(pasted)).toBe(3);
    const cleared = setRowSerials(pasted, "");
    expect(rowQuantity(cleared)).toBe(3);
  });

  test("a scanned serial is appended to the row it was scanned for, and the count follows", () => {
    const one = addScannedSerial(ROW, "PF1");
    const two = addScannedSerial(one, " PF2 ");
    expect(two.serials).toBe("PF1\nPF2");
    expect(rowQuantity(two)).toBe(2);
  });

  test("the submit counts every row, assets and stock together", () => {
    const rows = { [LAPTOPS.id]: { ...ROW, serials: "A\nB" }, [TONER.id]: { ...ROW, quantity: 5 } };
    expect(deliveryUnits(rows, [LAPTOPS.id, DOCKS.id, TONER.id])).toBe(7);
  });
});

describe("the shared delivery values", () => {
  test("the invoice date, status In storage and the purchase's delivery location", () => {
    expect(deliveryPrefill(PURCHASE, "2026-04-02")).toEqual({
      shared: { purchaseDate: "2026-03-10", status: "IN_STORAGE", statusLabelId: "", locationId: LOCATION },
      dateSource: "INVOICE",
    });
  });

  test("today when the purchase has no invoice date — never the order date", () => {
    expect(deliveryPrefill({ invoiceDate: null, deliveryLocationId: null }, "2026-04-02")).toEqual({
      shared: { purchaseDate: "2026-04-02", status: "IN_STORAGE", statusLabelId: "", locationId: "" },
      dateSource: "TODAY",
    });
  });
});

describe("the requests a delivery sends", () => {
  const lines = [LAPTOPS, DOCKS, TONER];
  const shared = deliveryPrefill(PURCHASE, "2026-04-02").shared;
  const plan = (rows: Record<string, DeliveryRow>, sharedValues = shared) =>
    buildDeliveryPlan({ purchase: PURCHASE, lines, rows, shared: sharedValues, today: "2026-04-02", locale: "en" });

  test("nothing counted is nothing to send", () => {
    expect(plan({ [LAPTOPS.id]: ROW, [TONER.id]: ROW })).toEqual({ ok: false, empty: true, errors: {} });
  });

  test("one request per counted line; rows at zero are skipped", () => {
    const result = plan({
      [LAPTOPS.id]: { ...ROW, modelId: MODEL, serials: "PF1\nPF2" , quantity: 2 },
      [DOCKS.id]: ROW,
      [TONER.id]: { ...ROW, consumableId: CONSUMABLE, quantity: 6 },
    });
    if (!result.ok) throw new Error("expected a plan");
    expect(result.steps.map((step) => [step.kind, step.line.id])).toEqual([
      ["ASSET", LAPTOPS.id],
      ["CONSUMABLE", TONER.id],
    ]);
  });

  test("an asset line sends the single receive's body: the line's cost, company and warranty with the shared values", () => {
    const result = plan({ [LAPTOPS.id]: { ...ROW, modelId: MODEL, serials: "PF1\nPF2", quantity: 2 } });
    if (!result.ok) throw new Error("expected a plan");
    expect(result.steps[0]).toEqual({
      kind: "ASSET",
      line: LAPTOPS,
      saveModelId: null,
      payload: {
        quantity: 2,
        serials: ["PF1", "PF2"],
        status: "IN_STORAGE",
        modelId: MODEL,
        company: "Acme S.A.",
        purchaseDate: "2026-03-10T00:00:00.000Z",
        warrantyEnd: "2029-03-10T00:00:00.000Z",
        purchaseCost: 141250000,
        purchaseCurrency: "ARS",
      },
    });
  });

  test("a changed date moves the warranty end with it; a changed status and location are sent", () => {
    const result = plan(
      { [LAPTOPS.id]: { ...ROW, modelId: MODEL, quantity: 1 } },
      { purchaseDate: "2026-04-02", status: "OPERATIONAL", statusLabelId: STATUS_LABEL, locationId: OTHER_LOCATION },
    );
    if (!result.ok || result.steps[0]?.kind !== "ASSET") throw new Error("expected an asset step");
    const { payload } = result.steps[0];
    expect(payload.purchaseDate).toBe("2026-04-02T00:00:00.000Z");
    expect(payload.warrantyEnd).toBe("2029-04-02T00:00:00.000Z");
    expect(payload.status).toBe("OPERATIONAL");
    expect(payload.statusLabelId).toBe(STATUS_LABEL);
    expect(payload.locationId).toBe(OTHER_LOCATION);
    expect(payload.serials).toBeUndefined();
    expect(payload.quantity).toBe(1);
  });

  test("a cleared location and date are sent as null, never omitted", () => {
    const result = plan(
      { [LAPTOPS.id]: { ...ROW, modelId: MODEL, quantity: 1 } },
      { ...shared, purchaseDate: "", locationId: "" },
    );
    if (!result.ok || result.steps[0]?.kind !== "ASSET") throw new Error("expected an asset step");
    expect(result.steps[0].payload.locationId).toBeNull();
    expect(result.steps[0].payload.purchaseDate).toBeNull();
    expect(result.steps[0].payload.warrantyEnd).toBeNull();
  });

  test("a line with no model needs one picked, which is saved on the line first", () => {
    expect(plan({ [DOCKS.id]: { ...ROW, quantity: 2 } })).toEqual({
      ok: false,
      empty: false,
      errors: { [DOCKS.id]: "modelRequired" },
    });
    const result = plan({ [DOCKS.id]: { ...ROW, quantity: 2, modelId: OTHER_MODEL } });
    if (!result.ok || result.steps[0]?.kind !== "ASSET") throw new Error("expected an asset step");
    expect(result.steps[0].saveModelId).toBe(OTHER_MODEL);
    expect(result.steps[0].payload.modelId).toBe(OTHER_MODEL);
    // No price on the line: no cost and no currency.
    expect(result.steps[0].payload.purchaseCost).toBeNull();
    expect(result.steps[0].payload.purchaseCurrency).toBeNull();
  });

  test("a consumable line sends the count only; with no consumable one is picked and saved first", () => {
    const mapped = plan({ [TONER.id]: { ...ROW, quantity: 6 } });
    if (!mapped.ok) throw new Error("expected a plan");
    expect(mapped.steps[0]).toEqual({ kind: "CONSUMABLE", line: TONER, saveConsumableId: null, payload: { quantity: 6 } });

    const unmappedLine = { ...TONER, consumableId: null };
    const unmapped = buildDeliveryPlan({
      purchase: PURCHASE,
      lines: [unmappedLine],
      rows: { [TONER.id]: { ...ROW, quantity: 6 } },
      shared,
      today: "2026-04-02",
      locale: "en",
    });
    expect(unmapped).toEqual({ ok: false, empty: false, errors: { [TONER.id]: "consumableRequired" } });
    const picked = buildDeliveryPlan({
      purchase: PURCHASE,
      lines: [unmappedLine],
      rows: { [TONER.id]: { ...ROW, quantity: 6, consumableId: CONSUMABLE } },
      shared,
      today: "2026-04-02",
      locale: "en",
    });
    if (!picked.ok || picked.steps[0]?.kind !== "CONSUMABLE") throw new Error("expected a stock step");
    expect(picked.steps[0].saveConsumableId).toBe(CONSUMABLE);
  });

  test("one row to fix stops the whole delivery before anything is sent", () => {
    const result = plan({
      [LAPTOPS.id]: { ...ROW, modelId: MODEL, quantity: 1 },
      [DOCKS.id]: { ...ROW, quantity: 1 },
    });
    expect(result.ok).toBe(false);
  });

  test("a serial longer than the route keeps is refused on its row", () => {
    expect(plan({ [LAPTOPS.id]: { ...ROW, modelId: MODEL, serials: "x".repeat(201), quantity: 1 } })).toEqual({
      ok: false,
      empty: false,
      errors: { [LAPTOPS.id]: "invalid" },
    });
  });
});

describe("the combined result", () => {
  test("an asset receive reads as received, partial or failed", () => {
    expect(assetOutcome("a", { created: [1, 2], failed: [], overReceived: false }).state).toBe("received");
    expect(assetOutcome("a", { created: [1], failed: [{ index: 1, error: "dup" }], overReceived: false }).state).toBe(
      "partial",
    );
    expect(assetOutcome("a", { created: [], failed: [{ index: 0, error: "dup" }], overReceived: false }).state).toBe(
      "failed",
    );
  });

  test("units received across lines, and the lines that need a look", () => {
    expect(
      summarizeDelivery([
        assetOutcome("a", { created: [1, 2], failed: [], overReceived: false }),
        assetOutcome("b", { created: [1], failed: [{ index: 1, error: "dup" }], overReceived: true }),
        { lineId: "c", kind: "CONSUMABLE", state: "received", created: 6, overReceived: false },
        { lineId: "d", kind: "ASSET", state: "error", message: "boom" },
      ]),
    ).toEqual({ units: 9, linesReceived: 2, linesWithProblems: 2 });
  });
});

describe("the delivery-note photo", () => {
  test("the picker offers the allowlist's images and PDF — what a phone camera and a scan produce", () => {
    expect(DELIVERY_NOTE_ACCEPT.split(",")).toEqual(["application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"]);
  });
});
