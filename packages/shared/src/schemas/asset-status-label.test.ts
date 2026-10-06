import { describe, expect, test } from "bun:test";
import {
  ASSET_STATUS_REQUIRED_MESSAGE,
  AssetListItemSchema,
  AssetSchema,
  AssetStatusLabelRefSchema,
  AssetWithRelationsSchema,
  BatchAssetStatusSchema,
  CreateAssetSchema,
  ReceiveAssetsSchema,
  ReceiveFromLineSchema,
  UpdateAssetSchema,
} from "../index";
import {
  ASSET_STATUS_LABEL_NAME_MAX,
  AssetStatusLabelListQuerySchema,
  AssetStatusLabelSchema,
  CreateAssetStatusLabelSchema,
  DeleteAssetStatusLabelQuerySchema,
  UpdateAssetStatusLabelSchema,
} from "./asset-status-label";

/**
 * Custom asset statuses (ADR-0101, #1524): an operator-defined name mapped to one built-in AssetStatus.
 * Writes are validated here; the read shapes stay tolerant so a row that predates a rule still loads.
 */

const LABEL_ID = "ckq3l4bel0000000000000001";
const ASSET_ID = "ckq3asset000000000000001";
const NOW = "2026-10-05T12:00:00.000Z";

const labelRow = {
  id: LABEL_ID,
  name: "In repair at vendor",
  kind: "IN_MAINTENANCE",
  color: "#F59E0B",
  description: null,
  order: null,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};

describe("CreateAssetStatusLabelSchema", () => {
  test("accepts a name and a built-in kind", () => {
    const parsed = CreateAssetStatusLabelSchema.parse({ name: "  Loaner pool ", kind: "IN_STORAGE" });
    expect(parsed).toEqual({ name: "Loaner pool", kind: "IN_STORAGE" });
  });

  test("requires a kind from the built-in statuses", () => {
    expect(CreateAssetStatusLabelSchema.safeParse({ name: "X" }).success).toBe(false);
    expect(CreateAssetStatusLabelSchema.safeParse({ name: "X", kind: "BROKEN" }).success).toBe(false);
  });

  test("bounds the name", () => {
    expect(CreateAssetStatusLabelSchema.safeParse({ name: "  ", kind: "LOST" }).success).toBe(false);
    const long = "x".repeat(ASSET_STATUS_LABEL_NAME_MAX + 1);
    expect(CreateAssetStatusLabelSchema.safeParse({ name: long, kind: "LOST" }).success).toBe(false);
  });

  test("validates the colour as #RRGGBB on write", () => {
    for (const color of ["#3b82f6", "#3B82F6"]) {
      expect(CreateAssetStatusLabelSchema.safeParse({ name: "X", kind: "LOST", color }).success).toBe(true);
    }
    for (const color of ["3B82F6", "#3B8", "#GGGGGG", "red", "#3B82F6AA"]) {
      expect(CreateAssetStatusLabelSchema.safeParse({ name: "X", kind: "LOST", color }).success).toBe(false);
    }
  });

  test("bounds the order and refuses unknown keys", () => {
    expect(CreateAssetStatusLabelSchema.safeParse({ name: "X", kind: "LOST", order: -1 }).success).toBe(false);
    expect(CreateAssetStatusLabelSchema.safeParse({ name: "X", kind: "LOST", order: 3 }).success).toBe(true);
    expect(CreateAssetStatusLabelSchema.safeParse({ name: "X", kind: "LOST", id: LABEL_ID }).success).toBe(false);
  });
});

describe("UpdateAssetStatusLabelSchema", () => {
  test("rejects an empty body", () => {
    expect(UpdateAssetStatusLabelSchema.safeParse({}).success).toBe(false);
  });

  test("takes null to clear colour, description and order", () => {
    expect(UpdateAssetStatusLabelSchema.parse({ color: null, description: null, order: null })).toEqual({
      color: null,
      description: null,
      order: null,
    });
  });

  test("allows a kind change in the body (the API refuses it while assets use the label)", () => {
    expect(UpdateAssetStatusLabelSchema.parse({ kind: "RETIRED" })).toEqual({ kind: "RETIRED" });
  });

  test("still validates the colour", () => {
    expect(UpdateAssetStatusLabelSchema.safeParse({ color: "blue" }).success).toBe(false);
  });
});

describe("DeleteAssetStatusLabelQuerySchema", () => {
  test("accepts no target, a label target or a built-in status target", () => {
    expect(DeleteAssetStatusLabelQuerySchema.parse({})).toEqual({});
    expect(DeleteAssetStatusLabelQuerySchema.parse({ reassignLabelId: LABEL_ID })).toEqual({
      reassignLabelId: LABEL_ID,
    });
    expect(DeleteAssetStatusLabelQuerySchema.parse({ reassignStatus: "RETIRED" })).toEqual({
      reassignStatus: "RETIRED",
    });
  });

  test("refuses both targets at once, a bad id and an unknown status", () => {
    expect(
      DeleteAssetStatusLabelQuerySchema.safeParse({ reassignLabelId: LABEL_ID, reassignStatus: "LOST" }).success,
    ).toBe(false);
    expect(DeleteAssetStatusLabelQuerySchema.safeParse({ reassignLabelId: "nope" }).success).toBe(false);
    expect(DeleteAssetStatusLabelQuerySchema.safeParse({ reassignStatus: "GONE" }).success).toBe(false);
  });
});

describe("AssetStatusLabelListQuerySchema", () => {
  test("defaults to the live slice", () => {
    expect(AssetStatusLabelListQuerySchema.parse({})).toEqual({ deleted: "active" });
    expect(AssetStatusLabelListQuerySchema.parse({ deleted: "only" })).toEqual({ deleted: "only" });
    expect(AssetStatusLabelListQuerySchema.safeParse({ deleted: "all" }).success).toBe(false);
  });
});

describe("AssetStatusLabelSchema (read)", () => {
  test("reads a row with or without assetCount", () => {
    expect(AssetStatusLabelSchema.parse(labelRow)).toEqual(labelRow);
    expect(AssetStatusLabelSchema.parse({ ...labelRow, assetCount: 4 }).assetCount).toBe(4);
  });

  test("stays tolerant of a stored colour that the write rule would refuse", () => {
    expect(AssetStatusLabelSchema.safeParse({ ...labelRow, color: "teal" }).success).toBe(true);
  });

  test("the ref is the compact { id, name, kind, color }", () => {
    const { id, name, kind, color } = labelRow;
    expect(AssetStatusLabelRefSchema.parse({ id, name, kind, color, extra: 1 })).toEqual({ id, name, kind, color });
  });
});

describe("Asset reads carry the custom status (tolerant)", () => {
  const asset = {
    id: ASSET_ID,
    name: "Laptop",
    serial: null,
    assetTag: null,
    status: "IN_MAINTENANCE",
    specs: null,
    notes: null,
    company: null,
    purchaseDate: null,
    warrantyEnd: null,
    modelId: null,
    locationId: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
  const ref = { id: LABEL_ID, name: "In repair at vendor", kind: "IN_MAINTENANCE", color: null };

  test("an asset without the new fields still parses (older rows, older builds)", () => {
    expect(AssetSchema.safeParse(asset).success).toBe(true);
  });

  test("the lean, list and expanded reads accept statusLabelId and statusLabel", () => {
    const withLabel = { ...asset, statusLabelId: LABEL_ID, statusLabel: ref };
    expect(AssetSchema.parse(withLabel).statusLabel).toEqual(ref);
    const listRow = { ...withLabel, model: null, location: null, activeAssignments: [] };
    expect(AssetListItemSchema.parse(listRow).statusLabelId).toBe(LABEL_ID);
    expect(AssetWithRelationsSchema.parse({ ...withLabel, model: null, location: null, activeAssignments: [] }))
      .toMatchObject({ statusLabel: ref });
    expect(AssetSchema.parse({ ...asset, statusLabelId: null, statusLabel: null }).statusLabel).toBeNull();
  });
});

describe("CreateAssetSchema — status or custom status", () => {
  test("takes a built-in status, a custom status, or both", () => {
    expect(CreateAssetSchema.safeParse({ name: "A", status: "OPERATIONAL" }).success).toBe(true);
    expect(CreateAssetSchema.safeParse({ name: "A", statusLabelId: LABEL_ID }).success).toBe(true);
    expect(
      CreateAssetSchema.safeParse({ name: "A", status: "IN_MAINTENANCE", statusLabelId: LABEL_ID }).success,
    ).toBe(true);
  });

  test("refuses neither, with one message on `status`", () => {
    const result = CreateAssetSchema.safeParse({ name: "A" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.path[0] === "status" && i.message === ASSET_STATUS_REQUIRED_MESSAGE))
      .toBe(true);
  });

  test("refuses a malformed label id", () => {
    expect(CreateAssetSchema.safeParse({ name: "A", statusLabelId: "nope" }).success).toBe(false);
  });

  test("still exposes its keys (the import mapping reads the shape)", () => {
    expect(Object.keys(CreateAssetSchema.shape)).toContain("statusLabelId");
    expect(Object.keys(CreateAssetSchema.shape)).toContain("status");
  });
});

describe("UpdateAssetSchema — custom status", () => {
  test("sets, clears, or leaves the custom status", () => {
    expect(UpdateAssetSchema.parse({ statusLabelId: LABEL_ID })).toEqual({ statusLabelId: LABEL_ID });
    expect(UpdateAssetSchema.parse({ statusLabelId: null })).toEqual({ statusLabelId: null });
    expect(UpdateAssetSchema.parse({ status: "LOST" })).toEqual({ status: "LOST" });
  });
});

describe("Batch status and receiving take a custom status", () => {
  const ids = [ASSET_ID];

  test("batch status: status, statusLabelId or both; never neither", () => {
    expect(BatchAssetStatusSchema.safeParse({ ids, status: "LOST" }).success).toBe(true);
    expect(BatchAssetStatusSchema.safeParse({ ids, statusLabelId: LABEL_ID }).success).toBe(true);
    expect(BatchAssetStatusSchema.safeParse({ ids }).success).toBe(false);
    // null = the bare built-in status: needs a status alongside it.
    expect(
      BatchAssetStatusSchema.safeParse({ ids, status: "LOST", statusLabelId: null }).success,
    ).toBe(true);
    expect(BatchAssetStatusSchema.safeParse({ ids, statusLabelId: null }).success).toBe(false);
  });

  test("bulk receive: status or statusLabelId", () => {
    const base = { modelId: "ckq3model000000000000001", quantity: 2 };
    expect(ReceiveAssetsSchema.safeParse({ ...base, status: "IN_STORAGE" }).success).toBe(true);
    expect(ReceiveAssetsSchema.safeParse({ ...base, statusLabelId: LABEL_ID }).success).toBe(true);
    expect(ReceiveAssetsSchema.safeParse(base).success).toBe(false);
  });

  test("receive from a purchase line: statusLabelId is optional", () => {
    expect(ReceiveFromLineSchema.safeParse({ statusLabelId: LABEL_ID }).success).toBe(true);
    expect(ReceiveFromLineSchema.safeParse({}).success).toBe(true);
  });
});
