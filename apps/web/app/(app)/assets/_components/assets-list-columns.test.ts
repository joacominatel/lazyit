import { describe, expect, test } from "bun:test";
import {
  COLUMN_GROUPS,
  DEFAULT_VISIBLE_COLUMNS,
  HIDEABLE_COLUMNS,
  listCost,
  toggledColumns,
  visibleColumnSet,
} from "./assets-list-columns";

const NEW_COLUMNS = ["serial", "manufacturer", "purchaseDate", "warrantyEnd", "purchaseCost"];

/** The set an operator persisted before #1511 added columns: every column the picker then had. */
const STORED_BEFORE_1511 = [
  "assetTag",
  "model",
  "category",
  "location",
  "company",
  "status",
  "owners",
  "updated",
];

describe("assets list columns", () => {
  test("the picker groups list every hideable column exactly once", () => {
    const grouped = COLUMN_GROUPS.flatMap((group) => group.keys);
    expect([...grouped].sort()).toEqual([...HIDEABLE_COLUMNS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  test("the new columns sit in Details and in Purchase & warranty", () => {
    const groupOf = (key: string) => COLUMN_GROUPS.find((g) => g.keys.includes(key as never))?.id;
    expect(groupOf("serial")).toBe("details");
    expect(groupOf("manufacturer")).toBe("details");
    expect(groupOf("purchaseDate")).toBe("purchase");
    expect(groupOf("warrantyEnd")).toBe("purchase");
    expect(groupOf("purchaseCost")).toBe("purchase");
  });

  test("a list nobody configured shows exactly the columns it showed before", () => {
    expect(DEFAULT_VISIBLE_COLUMNS).toEqual(STORED_BEFORE_1511 as never);
    const visible = visibleColumnSet(undefined, true);
    for (const key of NEW_COLUMNS) expect(visible.has(key as never)).toBe(false);
  });

  test("a set stored before the new columns existed keeps them hidden", () => {
    const visible = visibleColumnSet(STORED_BEFORE_1511, true);
    expect([...visible]).toEqual(STORED_BEFORE_1511 as never);
  });

  test("before mount it is always the defaults, whatever is stored", () => {
    expect([...visibleColumnSet(["serial"], false)]).toEqual(DEFAULT_VISIBLE_COLUMNS);
  });

  test("garbage storage keeps only known keys", () => {
    expect([...visibleColumnSet(["serial", "nope", 3], true)]).toEqual(["serial"]);
    expect([...visibleColumnSet("garbage", true)]).toEqual(DEFAULT_VISIBLE_COLUMNS);
  });

  test("turning a column on re-emits the set in table order", () => {
    expect(toggledColumns(["assetTag", "updated"], "purchaseCost", true)).toEqual([
      "assetTag",
      "purchaseCost",
      "updated",
    ]);
    expect(toggledColumns(["assetTag", "updated"], "serial", true)).toEqual([
      "assetTag",
      "serial",
      "updated",
    ]);
  });

  test("turning a column off drops only that column", () => {
    expect(toggledColumns(["assetTag", "serial", "updated"], "serial", false)).toEqual([
      "assetTag",
      "updated",
    ]);
  });
});

describe("listCost", () => {
  test("shows the amount as entered with its currency label", () => {
    expect(listCost(123_456, "u$s", "en")).toEqual({ amount: "u$s 1,234.56", noCurrency: false });
    expect(listCost(150_000, "ARS", "es")).toEqual({ amount: "ARS 1.500", noCurrency: false });
  });

  test("flags an amount with no label as No currency", () => {
    expect(listCost(150_000, null, "en")).toEqual({ amount: "1,500", noCurrency: true });
    expect(listCost(150_000, "  ", "en")).toEqual({ amount: "1,500", noCurrency: true });
  });

  test("an unknown cost renders no amount", () => {
    expect(listCost(null, "USD", "en")).toBeNull();
    expect(listCost(undefined, undefined, "en")).toBeNull();
  });
});
