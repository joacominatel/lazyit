import { describe, expect, test } from "bun:test";
import type { PurchaseApplyAction, PurchaseLinkPreviewAsset } from "@lazyit/shared";
import {
  assetsToLink,
  buildLinkPayload,
  defaultChoices,
  everyValueChoices,
  failureViews,
  fieldGroups,
  linkSummary,
  setCell,
  setFieldGroup,
} from "./link-apply";

const A = "ck0000000000000000000000a";
const B = "ck0000000000000000000000b";
const C = "ck0000000000000000000000c";

type Actions = Partial<Record<"purchaseDate" | "purchaseCost" | "warrantyEnd" | "company" | "modelId", PurchaseApplyAction>>;

/** A preview asset whose fields carry the given actions (anything unlisted is SAME). */
function asset(id: string, actions: Actions, linkState: PurchaseLinkPreviewAsset["linkState"] = "NONE"): PurchaseLinkPreviewAsset {
  const plain = (action: PurchaseApplyAction = "SAME") => ({ current: null, purchase: null, action });
  return {
    assetId: id,
    name: `Laptop ${id.slice(-1)}`,
    assetTag: `LZ-${id.slice(-1)}`,
    linkState,
    linkedLineId: null,
    linkedPurchaseOrderId: null,
    fields: {
      purchaseDate: plain(actions.purchaseDate),
      purchaseCost: {
        current: { amount: null, currency: null },
        purchase: null,
        action: actions.purchaseCost ?? "SAME",
      },
      warrantyEnd: plain(actions.warrantyEnd),
      company: plain(actions.company),
      modelId: plain(actions.modelId),
    },
  };
}

describe("default choices (ADR-0099 §2, copy on confirm)", () => {
  test("a fill is pre-checked, a replace never is, and same / unavailable carry no choice", () => {
    const choices = defaultChoices([
      asset(A, { purchaseCost: "FILL", purchaseDate: "REPLACE", company: "UNAVAILABLE" }),
    ]);
    expect(choices[A]).toEqual({ purchaseCost: true, purchaseDate: false });
  });

  test("with the defaults, a link sends the fills only", () => {
    const assets = [asset(A, { purchaseCost: "FILL", purchaseDate: "REPLACE" })];
    expect(buildLinkPayload(assets, defaultChoices(assets))).toEqual({
      assetIds: [A],
      apply: ["purchaseCost"],
    });
  });

  test("nothing to fill and nothing chosen sends no apply list at all — values are never touched", () => {
    const assets = [asset(A, { purchaseDate: "REPLACE" }), asset(B, {})];
    expect(buildLinkPayload(assets, defaultChoices(assets))).toEqual({ assetIds: [A, B] });
  });
});

describe("mapping the choices to apply / applyByAsset", () => {
  test("the same choice everywhere is one apply list, no overrides", () => {
    const assets = [
      asset(A, { purchaseCost: "FILL", warrantyEnd: "FILL" }),
      asset(B, { purchaseCost: "FILL", warrantyEnd: "SAME" }),
    ];
    expect(buildLinkPayload(assets, defaultChoices(assets))).toEqual({
      assetIds: [A, B],
      apply: ["purchaseCost", "warrantyEnd"],
    });
  });

  test("a fill on one asset and an unchecked replace on another becomes a per-asset override", () => {
    // Cost: A is empty (fill, checked), B holds another amount (replace, unchecked).
    const assets = [asset(A, { purchaseCost: "FILL" }), asset(B, { purchaseCost: "REPLACE" })];
    const payload = buildLinkPayload(assets, defaultChoices(assets));
    expect(payload.apply).toBeUndefined();
    expect(payload.applyByAsset).toEqual({ [A]: ["purchaseCost"] });
  });

  test("an override lists every field that asset receives, including the shared ones", () => {
    const assets = [
      asset(A, { company: "FILL", purchaseCost: "FILL" }),
      asset(B, { company: "FILL", purchaseCost: "REPLACE" }),
    ];
    const payload = buildLinkPayload(assets, defaultChoices(assets));
    expect(payload.apply).toEqual(["company"]);
    expect(payload.applyByAsset).toEqual({ [A]: ["purchaseCost", "company"] });
  });

  test("a single cell checked in the per-asset grid replaces on that asset only", () => {
    const assets = [asset(A, { purchaseDate: "REPLACE" }), asset(B, { purchaseDate: "REPLACE" })];
    const choices = setCell(defaultChoices(assets), assets[1]!, "purchaseDate", true);
    expect(buildLinkPayload(assets, choices)).toEqual({
      assetIds: [A, B],
      applyByAsset: { [B]: ["purchaseDate"] },
    });
  });

  test("a cell with nothing to apply cannot be checked", () => {
    const assets = [asset(A, { purchaseDate: "SAME" })];
    const choices = setCell(defaultChoices(assets), assets[0]!, "purchaseDate", true);
    expect(choices[A]).toEqual({});
  });

  test("apply every purchase value checks fills and replaces alike", () => {
    const assets = [asset(A, { purchaseCost: "REPLACE", purchaseDate: "FILL" }), asset(B, { purchaseCost: "FILL" })];
    expect(buildLinkPayload(assets, everyValueChoices(assets))).toEqual({
      assetIds: [A, B],
      apply: ["purchaseDate", "purchaseCost"],
    });
  });

  test("the grouped replace toggle checks that field's replacements on every asset", () => {
    const assets = [asset(A, { purchaseCost: "REPLACE" }), asset(B, { purchaseCost: "REPLACE" }), asset(C, { purchaseCost: "FILL" })];
    const choices = setFieldGroup(defaultChoices(assets), assets, "purchaseCost", "REPLACE", true);
    expect(buildLinkPayload(assets, choices).apply).toEqual(["purchaseCost"]);
    const unfilled = setFieldGroup(choices, assets, "purchaseCost", "FILL", false);
    expect(buildLinkPayload(assets, unfilled).applyByAsset).toEqual({
      [A]: ["purchaseCost"],
      [B]: ["purchaseCost"],
    });
  });
});

describe("moving and the assets sent", () => {
  test("an asset already on this line is left out; one on another line only when moved", () => {
    const assets = [
      asset(A, {}, "NONE"),
      asset(B, {}, "THIS_LINE"),
      asset(C, {}, "OTHER_LINE"),
    ];
    expect(assetsToLink(assets, new Set()).map((a) => a.assetId)).toEqual([A]);
    expect(assetsToLink(assets, new Set([C])).map((a) => a.assetId)).toEqual([A, C]);
  });

  test("move: true is sent only when an asset linked elsewhere is included", () => {
    const fresh = [asset(A, {}, "NONE")];
    expect(buildLinkPayload(fresh, defaultChoices(fresh)).move).toBeUndefined();
    const moving = [asset(A, {}, "NONE"), asset(C, {}, "OTHER_LINE")];
    expect(buildLinkPayload(moving, defaultChoices(moving)).move).toBe(true);
  });
});

describe("the grouped diff and the result line", () => {
  test("counts each kind per field and what is checked", () => {
    const assets = [
      asset(A, { purchaseCost: "REPLACE", warrantyEnd: "FILL" }),
      asset(B, { purchaseCost: "FILL", warrantyEnd: "UNAVAILABLE" }),
    ];
    const cost = fieldGroups(assets, defaultChoices(assets)).find((g) => g.field === "purchaseCost")!;
    expect(cost).toEqual({
      field: "purchaseCost",
      fill: 1,
      fillChecked: 1,
      replace: 1,
      replaceChecked: 0,
      same: 0,
      unavailable: 0,
    });
    expect(linkSummary(assets, defaultChoices(assets))).toEqual({ linked: 2, filled: 2, replaced: 0 });
    expect(linkSummary(assets, everyValueChoices(assets))).toEqual({ linked: 2, filled: 2, replaced: 1 });
  });
});

describe("partial-failure reasons", () => {
  const names = new Map([[A, { name: "Laptop a", assetTag: "LZ-a" }]]);

  test("a known reason maps to its message key, labelled by tag and name", () => {
    expect(failureViews([{ assetId: A, reason: "LINKED_ELSEWHERE", error: "linked to another line" }], names)).toEqual([
      { assetId: A, label: "LZ-a · Laptop a", reasonKey: "linkedElsewhere", error: "linked to another line" },
    ]);
    expect(failureViews([{ assetId: A, reason: "NOT_FOUND", error: "x" }], names)[0]!.reasonKey).toBe("notFound");
    expect(failureViews([{ assetId: A, reason: "ALREADY_LINKED", error: "x" }], names)[0]!.reasonKey).toBe("alreadyLinked");
    expect(failureViews([{ assetId: A, reason: "NOT_LINKED", error: "x" }], names)[0]!.reasonKey).toBe("notLinked");
  });

  test("a reason a newer API adds falls back to the API's text, and an unknown asset to its id", () => {
    expect(failureViews([{ assetId: B, reason: "SOMETHING_NEW", error: "the API says why" }], names)).toEqual([
      { assetId: B, label: B, reasonKey: null, error: "the API says why" },
    ]);
  });
});
