import { describe, expect, test } from "bun:test";
import {
  batchStatusFields,
  choiceOf,
  createStatusFields,
  decodeStatusChoice,
  encodeStatusChoice,
  groupStatusOptions,
  hasCustomStatuses,
  labelOfChoice,
  safeLabelColor,
  type StatusLabelOption,
  updateStatusFields,
} from "./asset-status-options";

const loaner: StatusLabelOption = {
  id: "clloaner0001",
  name: "Loaner pool",
  kind: "IN_STORAGE",
  color: "#3B82F6",
  order: 2,
};
const imaging: StatusLabelOption = {
  id: "climaging001",
  name: "Awaiting imaging",
  kind: "IN_STORAGE",
  color: null,
  order: null,
};
const bench: StatusLabelOption = {
  id: "clbench00001",
  name: "On the bench",
  kind: "IN_MAINTENANCE",
  color: null,
  order: 1,
};

describe("groupStatusOptions", () => {
  test("one group per built-in status, in declaration order, even with no custom status", () => {
    const groups = groupStatusOptions(undefined);
    expect(groups.map((g) => g.status)).toEqual([
      "OPERATIONAL",
      "IN_MAINTENANCE",
      "IN_STORAGE",
      "RETIRED",
      "LOST",
      "UNKNOWN",
    ]);
    expect(hasCustomStatuses(groups)).toBe(false);
  });

  test("custom statuses sit under their kind, by order (unset last) then name", () => {
    const groups = groupStatusOptions([imaging, bench, loaner]);
    expect(groups.find((g) => g.status === "IN_STORAGE")?.labels.map((l) => l.id)).toEqual([
      loaner.id,
      imaging.id,
    ]);
    expect(groups.find((g) => g.status === "IN_MAINTENANCE")?.labels).toEqual([bench]);
    expect(hasCustomStatuses(groups)).toBe(true);
  });

  test("the asset's current custom status is added when the list lacks it, never twice", () => {
    expect(groupStatusOptions([], loaner)[2].labels).toEqual([loaner]);
    expect(groupStatusOptions([loaner], loaner)[2].labels).toEqual([loaner]);
  });
});

describe("encode / decode", () => {
  const groups = groupStatusOptions([loaner, bench]);

  test("a bare built-in status round-trips", () => {
    const value = encodeStatusChoice({ status: "RETIRED", labelId: null });
    expect(value).toBe("status:RETIRED");
    expect(decodeStatusChoice(value, groups)).toEqual({ status: "RETIRED", labelId: null });
  });

  test("a custom status decodes to its kind", () => {
    const value = encodeStatusChoice({ status: "IN_STORAGE", labelId: loaner.id });
    expect(value).toBe(`label:${loaner.id}`);
    expect(decodeStatusChoice(value, groups)).toEqual({ status: "IN_STORAGE", labelId: loaner.id });
  });

  test("an unknown value decodes to null", () => {
    expect(decodeStatusChoice("status:BROKEN", groups)).toBeNull();
    expect(decodeStatusChoice("label:clnothere0001", groups)).toBeNull();
    expect(decodeStatusChoice("ALL", groups)).toBeNull();
  });

  test("labelOfChoice finds the custom status of a choice", () => {
    expect(labelOfChoice({ status: "IN_STORAGE", labelId: loaner.id }, groups)).toEqual(loaner);
    expect(labelOfChoice({ status: "IN_STORAGE", labelId: null }, groups)).toBeNull();
  });
});

describe("choiceOf", () => {
  test("reads the label id, the inline ref, or none (an asset predating custom statuses)", () => {
    expect(choiceOf({ status: "OPERATIONAL" })).toEqual({ status: "OPERATIONAL", labelId: null });
    expect(choiceOf({ status: "IN_STORAGE", statusLabelId: loaner.id })).toEqual({
      status: "IN_STORAGE",
      labelId: loaner.id,
    });
    expect(choiceOf({ status: "IN_STORAGE", statusLabel: { id: loaner.id } })).toEqual({
      status: "IN_STORAGE",
      labelId: loaner.id,
    });
  });
});

describe("wire fields", () => {
  const custom = { status: "IN_STORAGE" as const, labelId: loaner.id };
  const bare = { status: "IN_STORAGE" as const, labelId: null };

  test("create: a custom status sends its id with its kind; a bare status sends no label key", () => {
    expect(createStatusFields(custom)).toEqual({ status: "IN_STORAGE", statusLabelId: loaner.id });
    expect(createStatusFields(bare)).toEqual({ status: "IN_STORAGE" });
  });

  test("update: a bare status clears the custom status explicitly", () => {
    expect(updateStatusFields(custom)).toEqual({ status: "IN_STORAGE", statusLabelId: loaner.id });
    expect(updateStatusFields(bare)).toEqual({ status: "IN_STORAGE", statusLabelId: null });
  });

  test("batch: one key — the custom status id, or the built-in status", () => {
    expect(batchStatusFields(custom)).toEqual({ statusLabelId: loaner.id });
    expect(batchStatusFields(bare)).toEqual({ status: "IN_STORAGE" });
  });
});

describe("safeLabelColor", () => {
  test("only #RRGGBB is painted", () => {
    expect(safeLabelColor("#3b82F6")).toBe("#3b82F6");
    expect(safeLabelColor(null)).toBeNull();
    expect(safeLabelColor("red")).toBeNull();
    expect(safeLabelColor("#fff")).toBeNull();
    expect(safeLabelColor("#000000;background:url(x)")).toBeNull();
  });
});
