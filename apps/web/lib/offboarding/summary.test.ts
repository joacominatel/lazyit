import { describe, expect, test } from "bun:test";
import type { OffboardConsumableRow, OffboardConsumables } from "./consumables";
import { actPreviewSections, offboardingImpact } from "./summary";
import type { OffboardAssetRow, OffboardGrantRow } from "./use-offboarding-data";

function asset(n: number): OffboardAssetRow {
  return {
    assignmentId: `as-${n}`,
    assetId: `asset-${n}`,
    resolved: true,
    name: `Laptop ${n}`,
    serial: null,
    assetTag: null,
    model: null,
    category: null,
    status: null,
  };
}

function grant(n: number): OffboardGrantRow {
  return {
    grantId: `gr-${n}`,
    applicationId: `app-${n}`,
    resolved: true,
    appName: `App ${n}`,
    accessLevel: null,
    expiresAt: null,
    isCritical: false,
  };
}

function row(deliveryId: number, outstanding = 0): OffboardConsumableRow {
  return {
    deliveryId,
    consumableId: `c-${deliveryId}`,
    name: `Item ${deliveryId}`,
    unit: "units",
    archived: false,
    quantity: 2,
    outstanding,
    deliveredAt: "2026-09-01T10:00:00.000Z",
  };
}

const NO_CONSUMABLES: OffboardConsumables = {
  toReturn: [],
  delivered: [],
  toReturnMore: 0,
  deliveredMore: 0,
};

const ALL_ON = { assets: true, access: true, consumables: true };

describe("offboardingImpact (#1532)", () => {
  const base = {
    isLoading: false,
    isError: false,
    consumablesUnavailable: false,
    assetCount: 2,
    grantCount: 0,
    consumables: { toReturn: [row(1, 1)], toReturnMore: 4 },
  };

  test("counts assets, grants and outstanding deliveries (unfetched ones included)", () => {
    expect(offboardingImpact(base)).toEqual({ assets: 2, access: 0, consumables: 5 });
  });

  test("loading or a failed read is unknown, never zero (issue #601)", () => {
    const unknown = { assets: null, access: null, consumables: null };
    expect(offboardingImpact({ ...base, isLoading: true })).toEqual(unknown);
    expect(offboardingImpact({ ...base, isError: true })).toEqual(unknown);
  });

  test("a refused consumables read leaves only that count unknown", () => {
    expect(offboardingImpact({ ...base, consumablesUnavailable: true })).toEqual({
      assets: 2,
      access: 0,
      consumables: null,
    });
  });
});

describe("actPreviewSections (#1532)", () => {
  const input = {
    assets: [asset(1), asset(2), asset(3), asset(4), asset(5)],
    grants: [grant(1)],
    consumables: {
      toReturn: [row(10, 1), row(11, 2)],
      delivered: [row(20)],
      toReturnMore: 0,
      deliveredMore: 0,
    },
    excluded: new Set<number>(),
    consumablesUnavailable: false,
    show: ALL_ON,
  };

  test("lists every section in print order, capping rows and counting the rest", () => {
    const sections = actPreviewSections(input, 3);
    expect(sections.map((s) => [s.kind, s.rows.length, s.more])).toEqual([
      ["assets", 3, 2],
      ["access", 1, 0],
      ["consumablesToReturn", 2, 0],
      ["consumablesDelivered", 1, 0],
    ]);
  });

  test("an empty assets or access section still prints (its 'nothing to return' line)", () => {
    const sections = actPreviewSections({
      ...input,
      assets: [],
      grants: [],
      consumables: NO_CONSUMABLES,
    });
    expect(sections.every((s) => s.rows.length === 0)).toBe(true);
    expect(sections.map((s) => s.kind)).toEqual(["assets", "access"]);
  });

  test("toggles drop their section", () => {
    const sections = actPreviewSections({
      ...input,
      show: { assets: false, access: true, consumables: false },
    });
    expect(sections.map((s) => s.kind)).toEqual(["access"]);
  });

  test("excluded deliveries are left off; a group with nothing kept is omitted", () => {
    const sections = actPreviewSections({ ...input, excluded: new Set([10, 11]) });
    expect(sections.map((s) => s.kind)).toEqual(["assets", "access", "consumablesDelivered"]);
  });

  test("a group with only unfetched rows still shows, so its '+N more' is not lost", () => {
    const sections = actPreviewSections({
      ...input,
      consumables: { ...NO_CONSUMABLES, toReturnMore: 7 },
    });
    const toReturn = sections.find((s) => s.kind === "consumablesToReturn");
    expect(toReturn?.rows).toEqual([]);
    expect(toReturn?.more).toBe(7);
  });

  test("a refused consumables read lists no consumables section", () => {
    const sections = actPreviewSections({ ...input, consumablesUnavailable: true });
    expect(sections.map((s) => s.kind)).toEqual(["assets", "access"]);
  });
});
