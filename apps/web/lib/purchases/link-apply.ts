/**
 * The "apply values from the purchase" step of linking existing assets to a line (ADR-0099 §2, "copy on
 * confirm"; UX proposal §3.e). Pure, so the rules that protect asset data are tested without React:
 *
 *   - a FILL (the asset is empty, the purchase has a value) is pre-checked;
 *   - a REPLACE (the asset holds a different value) is NEVER pre-checked — one switch checks them all;
 *   - SAME and UNAVAILABLE cells have nothing to apply and are never sent as a choice;
 *   - cost and currency are one field (`purchaseCost`), so they always move together.
 *
 * The request lists fields in `apply` (copied onto every asset where the purchase has a value) and
 * overrides that list per asset in `applyByAsset` — the shape the per-cell grid needs (#1473).
 */

import {
  type LinkAssetsToLine,
  PURCHASE_APPLY_FIELDS,
  type PurchaseApplyAction,
  type PurchaseApplyField,
  type PurchaseLinkFailureReason,
  type PurchaseLinkPreviewAsset,
} from "@lazyit/shared";

/** Per asset, per field: whether the value is copied. Only FILL / REPLACE cells carry a choice. */
export type ApplyChoices = Record<string, Partial<Record<PurchaseApplyField, boolean>>>;

/** The per-field diff action of one asset. */
export function actionOf(asset: PurchaseLinkPreviewAsset, field: PurchaseApplyField): PurchaseApplyAction {
  return asset.fields[field].action;
}

/** A cell the operator can choose for: something would actually change. */
export function isActionable(action: PurchaseApplyAction): action is "FILL" | "REPLACE" {
  return action === "FILL" || action === "REPLACE";
}

/**
 * The assets a link request sends: those not linked yet, plus those linked to another line that the
 * operator chose to move here (never moved silently). Assets already on this line are left out.
 */
export function assetsToLink(
  assets: readonly PurchaseLinkPreviewAsset[],
  moved: ReadonlySet<string>,
): PurchaseLinkPreviewAsset[] {
  return assets.filter(
    (asset) =>
      asset.linkState === "NONE" || (asset.linkState === "OTHER_LINE" && moved.has(asset.assetId)),
  );
}

/** The starting choices: every FILL checked, every REPLACE unchecked. */
export function defaultChoices(assets: readonly PurchaseLinkPreviewAsset[]): ApplyChoices {
  const choices: ApplyChoices = {};
  for (const asset of assets) {
    const row: Partial<Record<PurchaseApplyField, boolean>> = {};
    for (const field of PURCHASE_APPLY_FIELDS) {
      const action = actionOf(asset, field);
      if (isActionable(action)) row[field] = action === "FILL";
    }
    choices[asset.assetId] = row;
  }
  return choices;
}

/** "Apply every purchase value": every FILL and every REPLACE checked. */
export function everyValueChoices(assets: readonly PurchaseLinkPreviewAsset[]): ApplyChoices {
  const choices: ApplyChoices = {};
  for (const asset of assets) {
    const row: Partial<Record<PurchaseApplyField, boolean>> = {};
    for (const field of PURCHASE_APPLY_FIELDS) {
      if (isActionable(actionOf(asset, field))) row[field] = true;
    }
    choices[asset.assetId] = row;
  }
  return choices;
}

/** Check or uncheck one field's FILL (or REPLACE) cells across every asset — the grouped row's toggle. */
export function setFieldGroup(
  choices: ApplyChoices,
  assets: readonly PurchaseLinkPreviewAsset[],
  field: PurchaseApplyField,
  action: "FILL" | "REPLACE",
  checked: boolean,
): ApplyChoices {
  const next: ApplyChoices = { ...choices };
  for (const asset of assets) {
    if (actionOf(asset, field) !== action) continue;
    next[asset.assetId] = { ...next[asset.assetId], [field]: checked };
  }
  return next;
}

/** Check or uncheck one cell of the per-asset grid. A cell with nothing to apply is left alone. */
export function setCell(
  choices: ApplyChoices,
  asset: PurchaseLinkPreviewAsset,
  field: PurchaseApplyField,
  checked: boolean,
): ApplyChoices {
  if (!isActionable(actionOf(asset, field))) return choices;
  return { ...choices, [asset.assetId]: { ...choices[asset.assetId], [field]: checked } };
}

/** The fields one asset will receive. */
function checkedFields(choices: ApplyChoices, asset: PurchaseLinkPreviewAsset): PurchaseApplyField[] {
  return PURCHASE_APPLY_FIELDS.filter(
    (field) => isActionable(actionOf(asset, field)) && choices[asset.assetId]?.[field] === true,
  );
}

/** One field's row of the grouped diff: how many cells of each kind, and how many are checked. */
export interface FieldGroup {
  field: PurchaseApplyField;
  fill: number;
  fillChecked: number;
  replace: number;
  replaceChecked: number;
  same: number;
  unavailable: number;
}

/** The grouped diff — one row per field, not one per cell (bulk-linking 20 monitors is five decisions). */
export function fieldGroups(
  assets: readonly PurchaseLinkPreviewAsset[],
  choices: ApplyChoices,
): FieldGroup[] {
  return PURCHASE_APPLY_FIELDS.map((field) => {
    const group: FieldGroup = { field, fill: 0, fillChecked: 0, replace: 0, replaceChecked: 0, same: 0, unavailable: 0 };
    for (const asset of assets) {
      const checked = choices[asset.assetId]?.[field] === true;
      switch (actionOf(asset, field)) {
        case "FILL":
          group.fill += 1;
          if (checked) group.fillChecked += 1;
          break;
        case "REPLACE":
          group.replace += 1;
          if (checked) group.replaceChecked += 1;
          break;
        case "SAME":
          group.same += 1;
          break;
        case "UNAVAILABLE":
          group.unavailable += 1;
          break;
      }
    }
    return group;
  });
}

/** What the confirm button is about to do: assets linked, values filled, values replaced. */
export function linkSummary(
  assets: readonly PurchaseLinkPreviewAsset[],
  choices: ApplyChoices,
): { linked: number; filled: number; replaced: number } {
  let filled = 0;
  let replaced = 0;
  for (const group of fieldGroups(assets, choices)) {
    filled += group.fillChecked;
    replaced += group.replaceChecked;
  }
  return { linked: assets.length, filled, replaced };
}

/**
 * The request for the chosen cells. `apply` holds the fields checked on EVERY asset that has something to
 * apply for them, so the common case — the same choice everywhere — is one list and no overrides. An
 * asset that receives more than that gets its full list in `applyByAsset`. A field nobody checked is in
 * neither, so it is never touched. `move` is sent only when an asset linked elsewhere is being moved.
 */
export function buildLinkPayload(
  assets: readonly PurchaseLinkPreviewAsset[],
  choices: ApplyChoices,
): LinkAssetsToLine {
  const apply = PURCHASE_APPLY_FIELDS.filter((field) => {
    const actionable = assets.filter((asset) => isActionable(actionOf(asset, field)));
    return actionable.length > 0 && actionable.every((asset) => choices[asset.assetId]?.[field] === true);
  });
  const applyByAsset: Record<string, PurchaseApplyField[]> = {};
  for (const asset of assets) {
    const fields = checkedFields(choices, asset);
    if (fields.some((field) => !apply.includes(field))) applyByAsset[asset.assetId] = fields;
  }
  const move = assets.some((asset) => asset.linkState === "OTHER_LINE");
  return {
    assetIds: assets.map((asset) => asset.assetId),
    ...(apply.length > 0 ? { apply } : {}),
    ...(Object.keys(applyByAsset).length > 0 ? { applyByAsset } : {}),
    ...(move ? { move: true } : {}),
  };
}

/** Failure reason → its message key under `purchases.link.reasons`; a reason a newer API adds reads as its text. */
const REASON_KEY: Record<PurchaseLinkFailureReason, string> = {
  NOT_FOUND: "notFound",
  ALREADY_LINKED: "alreadyLinked",
  LINKED_ELSEWHERE: "linkedElsewhere",
  NOT_LINKED: "notLinked",
};

/**
 * One refused asset of a link or unlink, ready to print: its label (tag · name when known, else the raw
 * id) and either a localized reason key or, for a reason this build does not know, the API's own text.
 */
export interface FailureView {
  assetId: string;
  label: string;
  reasonKey: string | null;
  error: string;
}

export function failureViews(
  failed: readonly { assetId: string; reason: string; error: string }[],
  names: ReadonlyMap<string, { name: string; assetTag: string | null }>,
): FailureView[] {
  return failed.map((failure) => {
    const known = names.get(failure.assetId);
    const label = known ? [known.assetTag, known.name].filter(Boolean).join(" · ") : failure.assetId;
    const reasonKey =
      failure.reason in REASON_KEY ? REASON_KEY[failure.reason as PurchaseLinkFailureReason] : null;
    return { assetId: failure.assetId, label, reasonKey, error: failure.error };
  });
}
