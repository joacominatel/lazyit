import { describe, expect, test } from "bun:test";
import { ReceiveAssetsResultSchema, ReceiveAssetsSchema } from "./asset-receive";
import { AssetHistoryEventTypeSchema } from "./asset-history";
import { AttachmentEntityTypeSchema } from "./attachment";
import { PURCHASE_ORDER_EVENT_TYPES } from "./purchase-order";
import {
  CancelRemainingUnitsSchema,
  LinkAssetsToLineSchema,
  PURCHASE_LINK_MAX_ASSETS,
  PurchaseLinkPreviewRequestSchema,
  ReceiveFromLineSchema,
  UnlinkAssetsFromLineSchema,
} from "./purchase-receiving";

const A1 = "ckasset000000000000000001";
const A2 = "ckasset000000000000000002";

describe("LinkAssetsToLineSchema", () => {
  test("only the asset ids are required; apply defaults to nothing", () => {
    expect(LinkAssetsToLineSchema.parse({ assetIds: [A1] })).toEqual({ assetIds: [A1] });
  });

  test("apply takes only the known fields; applyByAsset is per asset", () => {
    expect(
      LinkAssetsToLineSchema.safeParse({
        assetIds: [A1, A2],
        apply: ["purchaseCost", "warrantyEnd"],
        applyByAsset: { [A2]: ["purchaseDate"] },
        move: true,
      }).success,
    ).toBe(true);
    expect(
      LinkAssetsToLineSchema.safeParse({ assetIds: [A1], apply: ["purchaseCurrency"] }).success,
    ).toBe(false);
    expect(LinkAssetsToLineSchema.safeParse({ assetIds: [A1], apply: ["serial"] }).success).toBe(false);
  });

  test("ids are non-empty, unique and bounded", () => {
    expect(LinkAssetsToLineSchema.safeParse({ assetIds: [] }).success).toBe(false);
    expect(LinkAssetsToLineSchema.safeParse({ assetIds: [A1, A1] }).success).toBe(false);
    const many = Array.from({ length: PURCHASE_LINK_MAX_ASSETS + 1 }, (_, i) =>
      `ckasset${String(i).padStart(18, "0")}`,
    );
    expect(LinkAssetsToLineSchema.safeParse({ assetIds: many }).success).toBe(false);
    expect(UnlinkAssetsFromLineSchema.safeParse({ assetIds: [A1] }).success).toBe(true);
    expect(PurchaseLinkPreviewRequestSchema.safeParse({ assetIds: [A1], apply: [] }).success).toBe(false);
  });
});

describe("ReceiveFromLineSchema — every field is an optional override", () => {
  test("an empty body is valid (everything comes from the purchase)", () => {
    expect(ReceiveFromLineSchema.safeParse({}).success).toBe(true);
  });

  test("null clears a prefilled value for this receive", () => {
    expect(
      ReceiveFromLineSchema.safeParse({ locationId: null, purchaseCost: null, company: null }).success,
    ).toBe(true);
  });

  test("serials must match an explicit quantity, and may stand alone", () => {
    expect(ReceiveFromLineSchema.safeParse({ serials: ["A", "B"] }).success).toBe(true);
    expect(ReceiveFromLineSchema.safeParse({ quantity: 2, serials: ["A", "B"] }).success).toBe(true);
    expect(ReceiveFromLineSchema.safeParse({ quantity: 3, serials: ["A", "B"] }).success).toBe(false);
  });
});

describe("CancelRemainingUnitsSchema", () => {
  test("quantity and reason are optional; a quantity is at least 1", () => {
    expect(CancelRemainingUnitsSchema.parse({})).toEqual({});
    expect(CancelRemainingUnitsSchema.parse({ reason: "  4th never came " }).reason).toBe("4th never came");
    expect(CancelRemainingUnitsSchema.safeParse({ quantity: 0 }).success).toBe(false);
  });
});

describe("bulk receive carries the purchase fields (additive)", () => {
  const base = { modelId: "ckxmodel00000000000000001", quantity: 1, status: "IN_STORAGE" };

  test("currency label, warranty end and the purchase line are accepted", () => {
    const parsed = ReceiveAssetsSchema.parse({
      ...base,
      purchaseCost: 1000,
      purchaseCurrency: " USD ",
      warrantyEnd: "2029-03-10T00:00:00.000Z",
      purchaseOrderLineId: "ckline0000000000000000001",
    });
    expect(parsed.purchaseCurrency).toBe("USD");
    expect(parsed.purchaseOrderLineId).toBe("ckline0000000000000000001");
  });

  test("a result without overReceived still parses (a receive not against a line)", () => {
    expect(ReceiveAssetsResultSchema.safeParse({ created: [], failed: [] }).success).toBe(true);
    expect(
      ReceiveAssetsResultSchema.safeParse({ created: [], failed: [], overReceived: true }).success,
    ).toBe(true);
  });
});

describe("enum appends (ADR-0099 §14: appended at the tail)", () => {
  test("asset history gains PURCHASE_LINKED / PURCHASE_UNLINKED after every existing value", () => {
    expect(AssetHistoryEventTypeSchema.options.slice(-2)).toEqual(["PURCHASE_LINKED", "PURCHASE_UNLINKED"]);
  });

  test("attachments gain the PURCHASE_ORDER parent", () => {
    expect(AttachmentEntityTypeSchema.options).toEqual(["ASSET", "ARTICLE", "PURCHASE_ORDER"]);
  });

  test("the purchase log gains the receiving, linking and document events", () => {
    expect(PURCHASE_ORDER_EVENT_TYPES.slice(-6)).toEqual([
      "UNITS_RECEIVED",
      "UNITS_CANCELLED",
      "ASSET_LINKED",
      "ASSET_UNLINKED",
      "DOCUMENT_ADDED",
      "DOCUMENT_REMOVED",
    ]);
  });
});
