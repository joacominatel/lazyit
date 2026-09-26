import { describe, expect, test } from "bun:test";
import { ApiError } from "@/lib/api/client";
import {
  buildOwnProfilePatch,
  isNameManagedByDirectory,
  ownProfileErrorKind,
} from "./own-profile";

describe("isNameManagedByDirectory", () => {
  test("a directory-synced or directory-only person is read-only", () => {
    expect(isNameManagedByDirectory({ directorySource: "ad", directoryOnly: false })).toBe(true);
    expect(isNameManagedByDirectory({ directorySource: null, directoryOnly: true })).toBe(true);
  });

  test("everyone else can edit, including an API that omits the field", () => {
    expect(isNameManagedByDirectory({ directorySource: null, directoryOnly: false })).toBe(false);
    expect(isNameManagedByDirectory({ directoryOnly: false })).toBe(false);
  });
});

describe("buildOwnProfilePatch", () => {
  const current = { firstName: "Ana", lastName: "Pérez" };

  test("sends only the changed names, trimmed", () => {
    expect(buildOwnProfilePatch(current, { firstName: " Ana María ", lastName: "Pérez" })).toEqual({
      firstName: "Ana María",
    });
    expect(buildOwnProfilePatch(current, { firstName: "Anna", lastName: "Paz" })).toEqual({
      firstName: "Anna",
      lastName: "Paz",
    });
  });

  test("nothing changed (after trimming) builds nothing", () => {
    expect(buildOwnProfilePatch(current, { firstName: "Ana ", lastName: " Pérez" })).toBeNull();
  });
});

describe("ownProfileErrorKind", () => {
  test("maps the documented API refusals", () => {
    expect(
      ownProfileErrorKind(new ApiError(409, "x", { code: "PROFILE_MANAGED_BY_DIRECTORY" })),
    ).toBe("managedByDirectory");
    expect(
      ownProfileErrorKind(new ApiError(403, "x", { code: "SERVICE_ACCOUNT_NOT_ALLOWED" })),
    ).toBe("serviceAccount");
    expect(ownProfileErrorKind(new ApiError(503, "x"))).toBe("identityProviderUnavailable");
    expect(ownProfileErrorKind(new ApiError(400, "x"))).toBe("invalid");
  });

  test("anything else is generic", () => {
    expect(ownProfileErrorKind(new ApiError(409, "x", { code: "OTHER" }))).toBe("generic");
    expect(ownProfileErrorKind(new ApiError(403, "x"))).toBe("generic");
    expect(ownProfileErrorKind(new Error("network"))).toBe("generic");
  });
});
