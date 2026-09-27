import { describe, expect, test } from "bun:test";
import {
  ASSET_SPECS_MAX_ARRAY_LENGTH,
  ASSET_SPECS_MAX_DEPTH,
  ASSET_SPECS_MAX_KEYS,
  ASSET_SPECS_MAX_STRING_LENGTH,
  AssetSchema,
  CreateAssetSchema,
  UpdateAssetSchema,
} from "./asset";

/**
 * The structural write bound on `Asset.specs` (SEC-072 / SEC-032). `specs` stays an open JSON object —
 * these tests pin the SIZE limits only: nesting depth, keys per object, array length, string length.
 * Validation is write-only: the read shape (`AssetSchema`) must keep accepting whatever is stored.
 */

const create = (specs: unknown) =>
  CreateAssetSchema.safeParse({ name: "Laptop", status: "OPERATIONAL", specs });
const update = (specs: unknown) => UpdateAssetSchema.safeParse({ specs });

/** An object `depth` levels deep, counting the specs record itself as level 1. */
function nested(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { leaf: "x" };
  for (let i = 1; i < depth; i++) node = { a: node };
  return node;
}

/** A realistic agent-backed asset's specs at the agent contract's own caps (AgentReportSchema). */
function agentBackedSpecs(): Record<string, unknown> {
  return {
    cpu: "i7",
    _infraAutoCreated: true,
    reportedAt: "2026-09-01T00:00:00.000Z",
    host: {
      hostname: "web-03",
      os: { family: "linux", name: "Debian", version: "12" },
      nics: Array.from({ length: 64 }, (_, i) => ({
        name: `eth${i}`,
        ipv4: Array.from({ length: 64 }, (_, j) => `10.0.${i}.${j}`),
        ipv6: Array.from({ length: 64 }, (_, j) => ({ address: `fe80::${i}:${j}`, scope: "link" })),
      })),
      disks: Array.from({ length: 256 }, (_, i) => ({
        device: `/dev/sd${i}`,
        mountpoint: "/".repeat(1024),
      })),
    },
    software: Array.from({ length: 5000 }, (_, i) => ({
      name: `pkg-${i}`,
      version: "1.0.0",
      source: "dpkg",
    })),
  };
}

describe("Asset specs write bound — nesting depth (SEC-032)", () => {
  test("rejects the SEC-032 reproduction (a 20 000-level chain) without throwing", () => {
    const deep = nested(20_000);
    expect(() => create({ root: deep })).not.toThrow();
    expect(create({ root: deep }).success).toBe(false);
    expect(update({ root: deep }).success).toBe(false);
  });

  test("accepts nesting exactly at the limit and rejects one level past it", () => {
    expect(create(nested(ASSET_SPECS_MAX_DEPTH)).success).toBe(true);
    expect(create(nested(ASSET_SPECS_MAX_DEPTH + 1)).success).toBe(false);
  });

  test("counts arrays as nesting levels", () => {
    let node: unknown = "x";
    for (let i = 1; i < ASSET_SPECS_MAX_DEPTH + 1; i++) node = [node];
    expect(update({ list: node }).success).toBe(false);
  });

  test("points the issue at specs", () => {
    const r = update(nested(ASSET_SPECS_MAX_DEPTH + 1));
    expect(r.success).toBe(false);
    expect(r.success === false && r.error.issues[0]?.path[0]).toBe("specs");
  });
});

describe("Asset specs write bound — size (SEC-072)", () => {
  test("caps the number of keys in any one object", () => {
    const keys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
    expect(create(keys(ASSET_SPECS_MAX_KEYS)).success).toBe(true);
    expect(create(keys(ASSET_SPECS_MAX_KEYS + 1)).success).toBe(false);
    expect(update({ nested: keys(ASSET_SPECS_MAX_KEYS + 1) }).success).toBe(false);
  });

  test("caps array length", () => {
    expect(update({ list: new Array(ASSET_SPECS_MAX_ARRAY_LENGTH).fill(1) }).success).toBe(true);
    expect(update({ list: new Array(ASSET_SPECS_MAX_ARRAY_LENGTH + 1).fill(1) }).success).toBe(false);
  });

  test("caps string values and keys alike", () => {
    const at = "x".repeat(ASSET_SPECS_MAX_STRING_LENGTH);
    const past = "x".repeat(ASSET_SPECS_MAX_STRING_LENGTH + 1);
    expect(create({ licence: at }).success).toBe(true);
    expect(create({ licence: past }).success).toBe(false);
    expect(create({ nested: { list: [past] } }).success).toBe(false);
    expect(create({ [past]: "v" }).success).toBe(false);
  });
});

describe("Asset specs write bound — realistic data stays valid", () => {
  test("accepts an agent-backed asset's specs at every agent contract cap", () => {
    // The web edit form re-sends preserved non-scalar specs on every save, so an asset the agent
    // populated must stay editable: the bound sits above everything AgentReportSchema admits.
    expect(update(agentBackedSpecs()).success).toBe(true);
  });

  test("accepts flat custom fields and an empty object", () => {
    expect(create({ ram: "16GB", cores: 8, ssd: true, note: null }).success).toBe(true);
    expect(update({}).success).toBe(true);
  });
});

describe("Asset specs read shape stays tolerant", () => {
  test("AssetSchema still accepts stored specs past the write bound", () => {
    const row = {
      id: "cjld2cjxh0000qzrmn831i7rn",
      name: "Legacy",
      serial: null,
      assetTag: null,
      status: "OPERATIONAL",
      specs: { root: nested(ASSET_SPECS_MAX_DEPTH + 5), blob: "x".repeat(ASSET_SPECS_MAX_STRING_LENGTH + 1) },
      notes: null,
      company: null,
      purchaseDate: null,
      warrantyEnd: null,
      modelId: null,
      locationId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    };
    expect(AssetSchema.safeParse(row).success).toBe(true);
  });
});
