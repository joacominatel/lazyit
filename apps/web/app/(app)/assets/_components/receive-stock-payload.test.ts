/**
 * Contract tests for the receive-stock form → wire-payload glue (issue #1229).
 *
 * The intake dialog now offers an inline "create model" path, so the model id can arrive from a
 * dialog that opened *after* the operator had already filled the rest of the form. These tests lock
 * the two things that must hold for that to be safe:
 *
 *  - the selected model id (freshly created or picked) is what lands in `modelId`, and
 *  - every other typed field survives the trip untouched — nothing is dropped or blanked because the
 *    model was chosen last.
 *
 * They also pin the empty-field contract that made this worth extracting: blank optional ids/dates
 * are OMITTED (an empty string fails `cuid()` / `datetime()`), money goes through `majorToMinor`,
 * and `serials` is absent rather than `[]` when nothing was pasted. `ReceiveAssetsSchema` is the
 * real validator, so each case is parsed through it.
 */

import { expect, describe, test } from "bun:test";
import { ReceiveAssetsSchema } from "@lazyit/shared";
import {
  buildReceivePayload,
  parseSerials,
  type ReceiveStockFormValues,
} from "./receive-stock-payload";

/** A form with only the required fields touched — everything optional left blank. */
const BLANK: ReceiveStockFormValues = {
  modelId: "clh1model0000000000000000",
  quantity: "1",
  status: "OPERATIONAL",
  locationId: "",
  company: "",
  purchaseDate: "",
  purchaseCost: "",
  notes: "",
  serials: "",
};

/** A fully-typed form — the state an operator has built up before they discover the model is missing. */
const TYPED: ReceiveStockFormValues = {
  modelId: "",
  quantity: "3",
  status: "IN_STORAGE",
  locationId: "clh1loc00000000000000000",
  company: "  Acme SA  ",
  purchaseDate: "2026-08-06",
  purchaseCost: "1234.56",
  notes: "  shipment 42  ",
  serials: " SN-1 \n\n SN-2 \nSN-3\n",
};

describe("buildReceivePayload — the inline-create hand-off (issue #1229)", () => {
  test("a model id chosen last is the one that lands in the payload", () => {
    const payload = buildReceivePayload({
      ...TYPED,
      modelId: "clh1newmodel00000000000000",
    });
    expect(payload.modelId).toBe("clh1newmodel00000000000000");
  });

  test("every other typed field survives choosing the model last", () => {
    const payload = buildReceivePayload({
      ...TYPED,
      modelId: "clh1newmodel00000000000000",
    });
    expect(payload).toMatchObject({
      quantity: 3,
      status: "IN_STORAGE",
      locationId: "clh1loc00000000000000000",
      company: "Acme SA",
      purchaseDate: "2026-08-06T00:00:00.000Z",
      purchaseCost: 123456,
      notes: "shipment 42",
      serials: ["SN-1", "SN-2", "SN-3"],
    });
  });

  test("the fully-typed payload is valid per ReceiveAssetsSchema", () => {
    const payload = buildReceivePayload({
      ...TYPED,
      modelId: "clh1newmodel00000000000000",
    });
    expect(ReceiveAssetsSchema.safeParse(payload).success).toBe(true);
  });
});

describe("buildReceivePayload — blank optional fields", () => {
  test("blank id/date fields are omitted, never sent as an empty string", () => {
    const payload = buildReceivePayload(BLANK);
    expect("locationId" in payload).toBe(false);
    expect("purchaseDate" in payload).toBe(false);
    expect("company" in payload).toBe(false);
    expect("notes" in payload).toBe(false);
  });

  test("serials is omitted when nothing was pasted (not an empty array)", () => {
    const payload = buildReceivePayload(BLANK);
    expect("serials" in payload).toBe(false);
  });

  test("a blank purchase cost becomes null (the schema's 'not set')", () => {
    expect(buildReceivePayload(BLANK).purchaseCost).toBeNull();
  });

  test("the minimal payload is valid per ReceiveAssetsSchema", () => {
    expect(ReceiveAssetsSchema.safeParse(buildReceivePayload(BLANK)).success).toBe(
      true,
    );
  });

  test("a whitespace-only company/notes counts as blank", () => {
    const payload = buildReceivePayload({
      ...BLANK,
      company: "   ",
      notes: "\n  ",
    });
    expect("company" in payload).toBe(false);
    expect("notes" in payload).toBe(false);
  });
});

describe("parseSerials", () => {
  test("trims each line and drops the empty ones", () => {
    expect(parseSerials(" A \n\n  B\n \nC ")).toEqual(["A", "B", "C"]);
  });

  test("blank input yields no serials", () => {
    expect(parseSerials("\n  \n")).toEqual([]);
  });
});
