import { describe, expect, test } from "bun:test";
import { ApiError } from "@/lib/api/client";
import { assignableRoles, canManageUser, isPromotion, userMutationErrorKind } from "./role-ceiling";

describe("assignableRoles — the role picker offers only roles at or below the caller's (SEC-088)", () => {
  test("an admin can grant every role", () => {
    expect(assignableRoles("ADMIN")).toEqual(["ADMIN", "MEMBER", "VIEWER"]);
  });

  test("a member with user:manage cannot grant admin", () => {
    expect(assignableRoles("MEMBER")).toEqual(["MEMBER", "VIEWER"]);
  });

  test("a viewer with user:manage can grant only viewer", () => {
    expect(assignableRoles("VIEWER")).toEqual(["VIEWER"]);
  });

  test("nothing is offered while the caller's role is unknown", () => {
    expect(assignableRoles(undefined)).toEqual([]);
  });
});

describe("canManageUser", () => {
  test("a member cannot act on an admin, but can on a member or viewer", () => {
    expect(canManageUser("MEMBER", { role: "ADMIN" })).toBe(false);
    expect(canManageUser("MEMBER", { role: "MEMBER" })).toBe(true);
    expect(canManageUser("MEMBER", { role: "VIEWER" })).toBe(true);
  });

  test("only an admin acts on an admin; an unknown caller acts on no one", () => {
    expect(canManageUser("ADMIN", { role: "ADMIN" })).toBe(true);
    expect(canManageUser(undefined, { role: "VIEWER" })).toBe(false);
  });
});

describe("userMutationErrorKind", () => {
  test("the ceiling 403 and the directory-person 422 are recognised by code", () => {
    expect(
      userMutationErrorKind(new ApiError(403, "x", { code: "ROLE_CEILING_EXCEEDED" })),
    ).toBe("roleCeiling");
    expect(
      userMutationErrorKind(new ApiError(422, "x", { code: "DIRECTORY_PERSON_ROLE_LOCKED" })),
    ).toBe("directoryRoleLocked");
  });

  test("the last-admin 409 is recognised by its code, not its wording", () => {
    expect(userMutationErrorKind(new ApiError(409, "x", { code: "LAST_ADMIN_REQUIRED" }))).toBe("lastAdmin");
    expect(
      userMutationErrorKind(new ApiError(409, "Cannot remove the last administrator who can sign in.")),
    ).toBeNull();
    expect(userMutationErrorKind(new ApiError(403, "x", { code: "LAST_ADMIN_REQUIRED" }))).toBeNull();
  });

  test("a department or job title change on a directory-synced person is recognised by code (#1646)", () => {
    expect(
      userMutationErrorKind(new ApiError(409, "x", { code: "PROFILE_MANAGED_BY_DIRECTORY" })),
    ).toBe("profileManagedByDirectory");
  });

  test("other failures fall through to the server's message", () => {
    expect(userMutationErrorKind(new ApiError(403, "You cannot change your own role"))).toBeNull();
    expect(userMutationErrorKind(new ApiError(409, "A record with this email already exists"))).toBeNull();
    expect(userMutationErrorKind(new ApiError(422, "x", { code: "OTHER" }))).toBeNull();
    expect(userMutationErrorKind(new Error("Failed to fetch"))).toBeNull();
  });
});

describe("isPromotion — a role going up cancels pending credentials (SEC-088)", () => {
  test("viewer to member, member to admin and viewer to admin are promotions", () => {
    expect(isPromotion("VIEWER", "MEMBER")).toBe(true);
    expect(isPromotion("MEMBER", "ADMIN")).toBe(true);
    expect(isPromotion("VIEWER", "ADMIN")).toBe(true);
  });

  test("a demotion or no change is not", () => {
    expect(isPromotion("ADMIN", "MEMBER")).toBe(false);
    expect(isPromotion("MEMBER", "VIEWER")).toBe(false);
    expect(isPromotion("MEMBER", "MEMBER")).toBe(false);
  });
});
