import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { consumableKeys } from "./use-consumables";
import { patchCachedStock } from "./use-consumable-movement-mutations";

/**
 * Regression for #221: the quick-adjust optimistic patch must bump the detail/list `currentStock`
 * WITHOUT touching the nested movement-ledger query. The ledger key
 * (`detail(id)/movements/…`) is prefixed by the detail key, so a prefix-matching cache write
 * (`setQueriesData({ queryKey: detail(id) }, …)`) would run the `Consumable` updater against the
 * movements ARRAY and spread it into a plain object — crashing the detail page's `movements.map`
 * with "e.map is not a function". `patchCachedStock` must use the EXACT `setQueryData` instead.
 *
 * Regression for #320: the list query caches the `Page<Consumable>` ENVELOPE
 * `{ items, total, limit, offset }` (getConsumables → ConsumableListPage), NOT a bare array. The
 * patch must map over `current.items` and preserve the envelope; mapping `current` directly (the
 * old code) throws "e.map is not a function" on the quick-adjust optimistic update.
 */

const CONSUMABLE_ID = "c_abc123";

function seededClient() {
  const qc = new QueryClient();
  qc.setQueryData(consumableKeys.detail(CONSUMABLE_ID), {
    id: CONSUMABLE_ID,
    currentStock: 12,
  });
  // The detail page always mounts the (unfiltered) movements query.
  qc.setQueryData(consumableKeys.movements(CONSUMABLE_ID, {}), [
    { id: 2, type: "ADJUSTMENT", quantity: 12 },
    { id: 1, type: "IN", quantity: 1 },
  ]);
  // A list query caches the `Page<Consumable>` envelope (NOT a bare array) — #320.
  qc.setQueryData(consumableKeys.list({}), {
    items: [
      { id: CONSUMABLE_ID, currentStock: 12 },
      { id: "other", currentStock: 5 },
    ],
    total: 2,
    limit: 20,
    offset: 0,
  });
  return qc;
}

test("quick-adjust does not change the TYPE of the cached movements value (stays an array)", () => {
  const qc = seededClient();
  const before = qc.getQueryData(consumableKeys.movements(CONSUMABLE_ID, {}));
  expect(Array.isArray(before)).toBe(true);

  patchCachedStock(qc, CONSUMABLE_ID, -1);

  const after = qc.getQueryData(consumableKeys.movements(CONSUMABLE_ID, {}));
  // The bug turned this into a plain object ({ "0": …, currentStock: NaN }); it must stay an array.
  expect(Array.isArray(after)).toBe(true);
  expect(after).toEqual(before);
});

test("quick-adjust still bumps the detail currentStock", () => {
  const qc = seededClient();

  patchCachedStock(qc, CONSUMABLE_ID, -1);

  const detail = qc.getQueryData<{ currentStock: number }>(
    consumableKeys.detail(CONSUMABLE_ID),
  );
  expect(detail?.currentStock).toBe(11);

  patchCachedStock(qc, CONSUMABLE_ID, 1);
  const detailAfterAddBack = qc.getQueryData<{ currentStock: number }>(
    consumableKeys.detail(CONSUMABLE_ID),
  );
  expect(detailAfterAddBack?.currentStock).toBe(12);
});

test("quick-adjust patches the matching row in the list ENVELOPE without crashing (#320)", () => {
  const qc = seededClient();

  // The old array-map code (`current?.map(...)`) threw "e.map is not a function" here because the
  // list cache is a `Page<Consumable>` envelope, not an array.
  expect(() => patchCachedStock(qc, CONSUMABLE_ID, -1)).not.toThrow();

  const list = qc.getQueryData<{
    items: Array<{ id: string; currentStock: number }>;
    total: number;
    limit: number;
    offset: number;
  }>(consumableKeys.list({}));
  // The envelope is preserved; only the matching row's currentStock is bumped.
  expect(list).toEqual({
    items: [
      { id: CONSUMABLE_ID, currentStock: 11 },
      { id: "other", currentStock: 5 },
    ],
    total: 2,
    limit: 20,
    offset: 0,
  });
});
