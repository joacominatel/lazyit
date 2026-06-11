import { describe, expect, test } from "bun:test";
import { CloneUserResultSchema, CloneUserSchema } from "./clone-user";

const ASSIGN_A = "clxaaaaaaaaaaaaaaaaaaaaaa";
const GRANT_A = "clxggggggggggggggggggggg1";
const VALID_PROFILE = {
  email: "new.hire@x.io",
  firstName: "New",
  lastName: "Hire",
};

// ADR-0058 §4 — the clone body. `profile` is a normally-validated CreateUser payload; the id lists are
// opt-in & defaulted; the engine toggle defaults to FALSE (safe-by-default).
describe("CloneUserSchema (ADR-0058)", () => {
  test("accepts a minimal body (profile only) and applies defaults", () => {
    const result = CloneUserSchema.safeParse({ profile: VALID_PROFILE });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cloneAssetAssignments).toEqual([]);
      expect(result.data.cloneAccessGrants).toEqual([]);
      // The ratified safe-by-default: a clone does NOT fire the workflow engine unless asked.
      expect(result.data.fireWorkflowsOnClonedGrants).toBe(false);
    }
  });

  test("accepts selected assignments + grants and the engine toggle on", () => {
    const result = CloneUserSchema.safeParse({
      profile: VALID_PROFILE,
      cloneAssetAssignments: [ASSIGN_A],
      cloneAccessGrants: [GRANT_A],
      fireWorkflowsOnClonedGrants: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fireWorkflowsOnClonedGrants).toBe(true);
    }
  });

  test("normalizes the nested profile (email lowercased) and threads manager/legajo", () => {
    const result = CloneUserSchema.safeParse({
      profile: {
        email: "  NEW.Hire@X.IO ",
        firstName: "New",
        lastName: "Hire",
        legajo: "  77 ",
        manager: { managerName: "Ana (HR)" },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.profile.email).toBe("new.hire@x.io");
      expect(result.data.profile.legajo).toBe("77");
    }
  });

  test("rejects a missing profile", () => {
    expect(CloneUserSchema.safeParse({}).success).toBe(false);
  });

  test("rejects an unknown top-level key (strictObject)", () => {
    expect(
      CloneUserSchema.safeParse({ profile: VALID_PROFILE, foo: 1 }).success,
    ).toBe(false);
  });

  test("rejects a profile that copies externalId (SEC-006, via nested strictObject)", () => {
    expect(
      CloneUserSchema.safeParse({
        profile: { ...VALID_PROFILE, externalId: "victim-sub" },
      }).success,
    ).toBe(false);
  });

  test("rejects duplicate assignment ids", () => {
    expect(
      CloneUserSchema.safeParse({
        profile: VALID_PROFILE,
        cloneAssetAssignments: [ASSIGN_A, ASSIGN_A],
      }).success,
    ).toBe(false);
  });

  test("rejects a non-cuid grant id", () => {
    expect(
      CloneUserSchema.safeParse({
        profile: VALID_PROFILE,
        cloneAccessGrants: ["not-a-cuid"],
      }).success,
    ).toBe(false);
  });
});

// ADR-0058 §4 — the per-item result (the ADR-0030 batch shape): the created user + the skipped ids.
describe("CloneUserResultSchema (ADR-0058)", () => {
  const CREATED = {
    id: "00000000-0000-0000-0000-000000000000",
    email: "new.hire@x.io",
    firstName: "New",
    lastName: "Hire",
    isActive: true,
    role: "VIEWER" as const,
    externalId: null,
    legajo: null,
    username: null,
    manager: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    deletedAt: null,
  };

  test("accepts a created user with skipped items", () => {
    const result = CloneUserResultSchema.safeParse({
      created: CREATED,
      skipped: [{ id: ASSIGN_A, reason: "asset_deleted" }],
    });
    expect(result.success).toBe(true);
  });

  test("accepts an empty skipped list", () => {
    expect(
      CloneUserResultSchema.safeParse({ created: CREATED, skipped: [] }).success,
    ).toBe(true);
  });
});
