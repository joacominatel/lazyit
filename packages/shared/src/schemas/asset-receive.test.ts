import { describe, expect, test } from "bun:test";
import {
  RECEIVE_ASSETS_MAX_QUANTITY,
  ReceiveAssetsResultSchema,
  ReceiveAssetsSchema,
} from "./asset-receive";

// Bulk receiving contract (ADR-0089 Part A, #1029). Guards the two behaviours the api relies on before
// any write: the quantity bounds (1..CAP) and the serials refinement (empty OR exactly `quantity`).

const base = {
  modelId: "ckxmodel00000000000000001",
  quantity: 3,
  status: "IN_STORAGE" as const,
};

describe("ReceiveAssetsSchema", () => {
  test("accepts the minimal payload (model + quantity + status)", () => {
    expect(ReceiveAssetsSchema.safeParse(base).success).toBe(true);
  });

  test("requires modelId (a receive is model-scoped — the name default comes from the model)", () => {
    const { modelId: _omit, ...noModel } = base;
    expect(ReceiveAssetsSchema.safeParse(noModel).success).toBe(false);
  });

  test("rejects quantity below 1 and above the CAP", () => {
    expect(ReceiveAssetsSchema.safeParse({ ...base, quantity: 0 }).success).toBe(
      false,
    );
    expect(
      ReceiveAssetsSchema.safeParse({
        ...base,
        quantity: RECEIVE_ASSETS_MAX_QUANTITY + 1,
      }).success,
    ).toBe(false);
    expect(
      ReceiveAssetsSchema.safeParse({
        ...base,
        quantity: RECEIVE_ASSETS_MAX_QUANTITY,
      }).success,
    ).toBe(true);
  });

  test("allows an absent or empty serials list (anonymous identical units)", () => {
    expect(ReceiveAssetsSchema.safeParse(base).success).toBe(true);
    expect(
      ReceiveAssetsSchema.safeParse({ ...base, serials: [] }).success,
    ).toBe(true);
  });

  test("accepts serials of exactly `quantity` length", () => {
    expect(
      ReceiveAssetsSchema.safeParse({
        ...base,
        serials: ["SN-1", "SN-2", "SN-3"],
      }).success,
    ).toBe(true);
  });

  test("rejects a serials/quantity length mismatch on the `serials` path (a 400 before any write)", () => {
    const result = ReceiveAssetsSchema.safeParse({
      ...base,
      serials: ["SN-1", "SN-2"], // quantity is 3
    });
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0]?.path).toEqual([
      "serials",
    ]);
  });

  test("carries purchaseCost verbatim as a non-negative integer (minor units, #954 — never re-coerced)", () => {
    const result = ReceiveAssetsSchema.safeParse({ ...base, purchaseCost: 12345 });
    expect(result.success).toBe(true);
    expect(result.success && result.data.purchaseCost).toBe(12345);
    // A fractional value is not minor units → rejected by int4.
    expect(
      ReceiveAssetsSchema.safeParse({ ...base, purchaseCost: 12.5 }).success,
    ).toBe(false);
  });

  test("rejects an unknown key (strictObject)", () => {
    expect(
      ReceiveAssetsSchema.safeParse({ ...base, warrantyEnd: "2027-01-01T00:00:00.000Z" })
        .success,
    ).toBe(false);
  });
});

describe("ReceiveAssetsResultSchema", () => {
  test("accepts an all-created result with an empty failed[]", () => {
    expect(
      ReceiveAssetsResultSchema.safeParse({ created: [], failed: [] }).success,
    ).toBe(true);
  });

  test("accepts a partial result carrying per-index failures", () => {
    const result = ReceiveAssetsResultSchema.safeParse({
      created: [],
      failed: [{ index: 1, error: "Unique constraint failed" }],
    });
    expect(result.success).toBe(true);
  });

  test("rejects a negative failure index", () => {
    expect(
      ReceiveAssetsResultSchema.safeParse({
        created: [],
        failed: [{ index: -1, error: "x" }],
      }).success,
    ).toBe(false);
  });
});
