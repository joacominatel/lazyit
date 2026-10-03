import { describe, expect, test } from "bun:test";
import { isPurchasePage } from "./open-purchase";

const ID = "ck00000000000000purchase1";

describe("isPurchasePage (#1505)", () => {
  test("on the purchase's own page the action is not offered", () => {
    expect(isPurchasePage(`/purchases/${ID}`, ID)).toBe(true);
  });

  test("from anywhere else it links to the purchase", () => {
    expect(isPurchasePage("/purchases/pending", ID)).toBe(false);
    expect(isPurchasePage("/assets", ID)).toBe(false);
    expect(isPurchasePage("/assets/ck0000000000000000000asset", ID)).toBe(false);
    expect(isPurchasePage("/purchases/ck00000000000000purchase2", ID)).toBe(false);
    expect(isPurchasePage(`/purchases/${ID}/edit`, ID)).toBe(false);
    expect(isPurchasePage(null, ID)).toBe(false);
  });
});
