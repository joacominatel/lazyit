import { describe, expect, test } from "bun:test";
import { deriveListState } from "@/lib/hooks/list-params-url";
import { derivePurchaseParams, PURCHASE_FILTER_DEFAULTS, PURCHASE_LIST_OPTIONS } from "./purchases-list-query";

const state = (filters: Partial<Record<keyof typeof PURCHASE_FILTER_DEFAULTS, string>>) => ({
  q: "",
  sort: undefined,
  dir: "desc" as const,
  offset: 0,
  limit: 50,
  filters: { ...PURCHASE_FILTER_DEFAULTS, ...filters },
});

describe("derivePurchaseParams", () => {
  test("the list opens on every purchase, newest recorded first (#1507)", () => {
    const opened = deriveListState(new URLSearchParams(), PURCHASE_LIST_OPTIONS);
    const params = derivePurchaseParams(opened, { isAdmin: false });
    expect(params.receipt).toBeUndefined();
    expect(params.status).toBeUndefined();
    expect(params.supplierId).toBeUndefined();
    expect(params).toMatchObject({ sort: "createdAt", dir: "desc", offset: 0 });
    expect(opened.filtersActive).toBe(false);
  });

  test("the purchases waiting for units are one filter away, and a chosen sort wins", () => {
    const pending = deriveListState(
      new URLSearchParams({ receipt: "PENDING", sort: "orderDate", dir: "asc" }),
      PURCHASE_LIST_OPTIONS,
    );
    expect(pending.filtersActive).toBe(true);
    expect(derivePurchaseParams(pending, { isAdmin: false })).toMatchObject({
      receipt: "PENDING",
      sort: "orderDate",
      dir: "asc",
    });
  });

  test("the archived view is not narrowed to pending purchases", () => {
    const params = derivePurchaseParams(state({ archived: "only" }), { isAdmin: true });
    expect(params.deleted).toBe("only");
    expect(params.receipt).toBeUndefined();
  });

  test("a non-admin cannot reach the archived view, so the receipt filter stays", () => {
    const params = derivePurchaseParams(state({ archived: "only", receipt: "PENDING" }), { isAdmin: false });
    expect(params.deleted).toBeUndefined();
    expect(params.receipt).toBe("PENDING");
  });

  test("a Cancelled filter lifts the receipt filter, which would exclude every cancelled purchase", () => {
    const params = derivePurchaseParams(state({ status: "CANCELLED", receipt: "PENDING" }), { isAdmin: false });
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
