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
