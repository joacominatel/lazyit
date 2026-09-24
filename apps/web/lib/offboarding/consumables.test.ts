import { describe, expect, test } from "bun:test";
import type { ConsumableDelivery, ConsumableDeliveryPage } from "@lazyit/shared";
import {
  EXCLUDE_DELIVERIES_PARAM,
  groupOffboardConsumables,
  offboardingActHref,
  parseExcludedDeliveries,
  selectOffboardConsumables,
} from "./consumables";

const USER = "11111111-1111-4111-8111-111111111111";

function delivery(
  id: number,
  overrides: Partial<ConsumableDelivery> & {
    name?: string;
    deletedAt?: string | null;
  } = {},
): ConsumableDelivery {
  const { name = `Item ${id}`, deletedAt = null, ...rest } = overrides;
  return {
    id,
    consumableId: `ckconsumable00000000000${String(id).padStart(2, "0")}`,
    type: "OUT",
    quantity: 3,
    reason: null,
    performedById: null,
    notes: null,
    targetUserId: USER,
    targetAssetId: null,
    targetLocationId: null,
    returnOfId: null,
    target: { type: "user", id: USER, displayName: "Ana Pérez", isOffboarded: false },
    createdAt: "2026-09-01T10:00:00.000Z",
    consumable: {
      id: `ckconsumable00000000000${String(id).padStart(2, "0")}`,
      name,
      sku: null,
      unit: "units",
      deletedAt,
    },
    returnable: false,
    returnedQuantity: 0,
    outstandingQuantity: 0,
    ...rest,
  };
}

function page(items: ConsumableDelivery[], total = items.length): ConsumableDeliveryPage {
  return { items, total, limit: 200, offset: 0 };
}

describe("groupOffboardConsumables (ADR-0098)", () => {
  const loaner = delivery(3, {
    name: "Loaner headset",
    returnable: true,
    returnedQuantity: 1,
    outstandingQuantity: 2,
  });
  const settled = delivery(2, { returnable: true, returnedQuantity: 3, outstandingQuantity: 0 });
  const toner = delivery(1, { name: "Toner", deletedAt: "2026-09-10T00:00:00.000Z" });

  test("to-return comes from the outstanding read; delivered is the non-returnable rows of the all read", () => {
    const grouped = groupOffboardConsumables(page([loaner]), page([loaner, settled, toner]));
    expect(grouped.toReturn.map((r) => [r.deliveryId, r.outstanding])).toEqual([[3, 2]]);
    // The settled returnable delivery appears in neither group; the consumed toner is informational.
    expect(grouped.delivered.map((r) => r.deliveryId)).toEqual([1]);
    expect(grouped.delivered[0]).toMatchObject({ name: "Toner", archived: true, outstanding: 0 });
  });

  test("an outstanding delivery the all-deliveries page missed is still to return (never under-report)", () => {
    // 200 newer consumed deliveries pushed the old loaner off the all page — the outstanding read has it.
    const grouped = groupOffboardConsumables(page([loaner]), page([toner], 201));
    expect(grouped.toReturn.map((r) => r.deliveryId)).toEqual([3]);
    expect(grouped.deliveredMore).toBe(200);
  });

  test("says how many were not fetched, honestly", () => {
    const grouped = groupOffboardConsumables(page([loaner], 250), page([toner], 1));
    expect(grouped.toReturnMore).toBe(249);
    expect(grouped.deliveredMore).toBe(0);
  });

  test("missing reads group to nothing", () => {
    expect(groupOffboardConsumables(undefined, undefined)).toEqual({
      toReturn: [],
      delivered: [],
      toReturnMore: 0,
      deliveredMore: 0,
    });
  });
});

describe("selectOffboardConsumables", () => {
  test("every row is included unless excluded", () => {
    const grouped = groupOffboardConsumables(
      page([delivery(3, { returnable: true, outstandingQuantity: 1 })]),
      page([delivery(1), delivery(2)]),
    );
    expect(selectOffboardConsumables(grouped, new Set())).toEqual({
      toReturn: grouped.toReturn,
      delivered: grouped.delivered,
    });
    const selected = selectOffboardConsumables(grouped, new Set([3, 1]));
    expect(selected.toReturn).toEqual([]);
    expect(selected.delivered.map((r) => r.deliveryId)).toEqual([2]);
  });
});

describe("the sheet → act hand-off", () => {
  test("no exclusions → the bare act URL", () => {
    expect(offboardingActHref(USER, new Set())).toBe(`/users/${USER}/offboarding/act`);
  });

  test("exclusions ride the URL, sorted, and parse back to the same set", () => {
    const href = offboardingActHref(USER, new Set([15, 3, 12]));
    expect(href).toBe(`/users/${USER}/offboarding/act?${EXCLUDE_DELIVERIES_PARAM}=3%2C12%2C15`);
    const param = new URL(href, "http://x").searchParams.get(EXCLUDE_DELIVERIES_PARAM);
    expect([...parseExcludedDeliveries(param)]).toEqual([3, 12, 15]);
  });

  test("the parser tolerates junk and a missing param", () => {
    expect([...parseExcludedDeliveries(null)]).toEqual([]);
    expect([...parseExcludedDeliveries("")]).toEqual([]);
    expect([...parseExcludedDeliveries("4, x,-2,1.5,0,7,,4")]).toEqual([4, 7]);
  });
});
