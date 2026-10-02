import { describe, expect, test } from "bun:test";
import { derivePurchaseParams, PURCHASE_FILTER_DEFAULTS } from "./purchases-list-query";

const state = (filters: Partial<Record<keyof typeof PURCHASE_FILTER_DEFAULTS, string>>) => ({
  q: "",
  sort: undefined,
  dir: "desc" as const,
  offset: 0,
  limit: 50,
  filters: { ...PURCHASE_FILTER_DEFAULTS, ...filters },
});

describe("derivePurchaseParams", () => {
  test("the list opens on purchases waiting for units", () => {
    expect(derivePurchaseParams(state({}), { isAdmin: false }).receipt).toBe("PENDING");
  });

  test("the archived view is not narrowed to pending purchases", () => {
    const params = derivePurchaseParams(state({ archived: "only" }), { isAdmin: true });
    expect(params.deleted).toBe("only");
    expect(params.receipt).toBeUndefined();
  });

  test("a non-admin cannot reach the archived view, so the default stays", () => {
    const params = derivePurchaseParams(state({ archived: "only" }), { isAdmin: false });
    expect(params.deleted).toBeUndefined();
    expect(params.receipt).toBe("PENDING");
  });

  test("a Cancelled filter lifts the receipt filter, which would exclude every cancelled purchase", () => {
    const params = derivePurchaseParams(state({ status: "CANCELLED" }), { isAdmin: false });
    expect(params.status).toEqual(["CANCELLED"]);
    expect(params.receipt).toBeUndefined();
  });

  test("an explicit receipt and supplier pass through; ALL lifts the receipt", () => {
    expect(
      derivePurchaseParams(state({ receipt: "OVER", supplier: "cksupplier0000000000000000" }), {
        isAdmin: false,
      }),
    ).toMatchObject({ receipt: "OVER", supplierId: "cksupplier0000000000000000" });
    expect(derivePurchaseParams(state({ receipt: "ALL" }), { isAdmin: false }).receipt).toBeUndefined();
  });
});
