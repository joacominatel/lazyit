import { describe, expect, test } from "bun:test";
import {
  AssetAssignmentWithUserSchema,
  AssetOwnerUserSchema,
} from "./asset-expanded";

const OWNER_ONLY = {
  id: "7b3f6c1e-2a4d-4e8b-9c1a-3f5e7d9b1c2a",
  email: "ana@example.com",
  firstName: "Ana",
  lastName: "Ops",
  deletedAt: null,
};

const FULL_OWNER = {
  ...OWNER_ONLY,
  isActive: true,
  role: "MEMBER",
  externalId: null,
  legajo: "E-1001",
  username: "ana.ops",
  manager: null,
  directoryOnly: false,
  directoryAttrs: { department: "IT" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const ASSIGNMENT = {
  id: "ckg9z1a2b0000qzrmn831k4d8",
  assetId: "ckg9z1a2b0001qzrmn831k4d8",
  userId: OWNER_ONLY.id,
  assignedAt: "2026-01-02T00:00:00.000Z",
  releasedAt: null,
  assignedById: null,
  releasedById: null,
  notes: null,
  createdAt: "2026-01-02T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

describe("AssetOwnerUserSchema (#1685)", () => {
  test("accepts the trimmed owner a caller without user:read gets", () => {
    expect(AssetOwnerUserSchema.parse(OWNER_ONLY)).toEqual(OWNER_ONLY);
  });

  test("accepts the full owner a caller with user:read gets", () => {
    expect(AssetOwnerUserSchema.parse(FULL_OWNER).legajo).toBe("E-1001");
  });

  test("still requires the inventory fields: id, name, email and deletedAt", () => {
    for (const key of ["id", "email", "firstName", "lastName", "deletedAt"]) {
      const { [key]: _omitted, ...rest } = OWNER_ONLY as Record<string, unknown>;
      expect(AssetOwnerUserSchema.safeParse(rest).success).toBe(false);
    }
  });

  test("an included directory field is still validated", () => {
    expect(
      AssetOwnerUserSchema.safeParse({ ...OWNER_ONLY, role: "NOT_A_ROLE" }).success,
    ).toBe(false);
  });
});

describe("AssetAssignmentWithUserSchema (#1685)", () => {
  test("validates both owner shapes", () => {
    expect(
      AssetAssignmentWithUserSchema.safeParse({ ...ASSIGNMENT, user: OWNER_ONLY }).success,
    ).toBe(true);
    expect(
      AssetAssignmentWithUserSchema.safeParse({ ...ASSIGNMENT, user: FULL_OWNER }).success,
    ).toBe(true);
  });
});
