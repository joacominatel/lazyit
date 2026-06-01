import { describe, expect, test } from "bun:test";
import {
  CreateAccessGrantSchema,
  UpdateAccessGrantNotesSchema,
} from "./access-grant";

const base = {
  userId: "11111111-1111-4111-8111-111111111111",
  applicationId: "clh1abc0000xyz0000000abcd",
};

// Cross-field refine (round-2 correctness): a grant cannot expire before it starts.
describe("CreateAccessGrantSchema — expiresAt >= grantedAt", () => {
  test("accepts expiresAt after grantedAt", () => {
    expect(
      CreateAccessGrantSchema.safeParse({
        ...base,
        grantedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-06-01T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  test("accepts expiresAt EQUAL to grantedAt (on-or-after, not strictly after)", () => {
    const t = "2026-01-01T00:00:00.000Z";
    expect(
      CreateAccessGrantSchema.safeParse({ ...base, grantedAt: t, expiresAt: t })
        .success,
    ).toBe(true);
  });

  test("rejects expiresAt BEFORE grantedAt", () => {
    const result = CreateAccessGrantSchema.safeParse({
      ...base,
      grantedAt: "2026-06-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  test("does not check when grantedAt is omitted (defaults to now() server-side)", () => {
    expect(
      CreateAccessGrantSchema.safeParse({
        ...base,
        expiresAt: "2026-01-01T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  test("does not check when expiresAt is omitted (no expiry)", () => {
    expect(
      CreateAccessGrantSchema.safeParse({
        ...base,
        grantedAt: "2026-01-01T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});

// The notes/expiry update schemas have a single REQUIRED nullable key, so an empty body already
// fails the base shape — confirm that contract holds (no requireAtLeastOneKey wrapper needed).
describe("UpdateAccessGrantNotesSchema — empty body", () => {
  test("rejects {} (notes is required, even though it is nullable)", () => {
    expect(UpdateAccessGrantNotesSchema.safeParse({}).success).toBe(false);
  });

  test("accepts an explicit null (clears the note)", () => {
    expect(UpdateAccessGrantNotesSchema.safeParse({ notes: null }).success).toBe(
      true,
    );
  });
});
