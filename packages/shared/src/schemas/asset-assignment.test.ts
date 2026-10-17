import { describe, expect, test } from "bun:test";
import {
  AssetAssignmentSchema,
  CreateAssetAssignmentSchema,
} from "./asset-assignment";

const base = {
  assetId: "clh1abc0000xyz0000000abcd",
  userId: "11111111-1111-4111-8111-111111111111",
};

// AUD-026: a future assignedAt would make the later release (releasedAt = now) land before it.
describe("CreateAssetAssignmentSchema — assignedAt", () => {
  test("accepts a backdated assignedAt", () => {
    expect(
      CreateAssetAssignmentSchema.safeParse({
        ...base,
        assignedAt: "2024-01-01T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  test("accepts an omitted assignedAt (the DB stamps now)", () => {
    expect(CreateAssetAssignmentSchema.safeParse(base).success).toBe(true);
  });

  test("refuses an assignedAt in the future", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const result = CreateAssetAssignmentSchema.safeParse({
      ...base,
      assignedAt: future,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      "assignedAt cannot be in the future",
    );
  });
});

// Reads stay tolerant: a row stored before the write rule, with a future assignedAt, still parses.
describe("AssetAssignmentSchema — read shape", () => {
  const row = {
    id: "clh1abc0000xyz0000000aaaa",
    ...base,
    assignedAt: "2030-01-01T00:00:00.000Z",
    releasedAt: null,
    assignedById: null,
    releasedById: null,
    notes: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  test("parses a row without the service-account actor keys", () => {
    expect(AssetAssignmentSchema.safeParse(row).success).toBe(true);
  });

  test("carries the service-account actor when one acted", () => {
    const parsed = AssetAssignmentSchema.parse({
      ...row,
      assignedBySaId: "clh1abc0000xyz0000000sa01",
      releasedBySaId: null,
    });
    expect(parsed.assignedBySaId).toBe("clh1abc0000xyz0000000sa01");
    expect(parsed.releasedBySaId).toBeNull();
  });
});
