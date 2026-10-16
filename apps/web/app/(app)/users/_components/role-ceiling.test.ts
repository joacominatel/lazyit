import { describe, expect, test } from "bun:test";
import { ApiError } from "@/lib/api/client";
import { assignableRoles, canManageUser, userMutationErrorKind } from "./role-ceiling";

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

  test("the last-admin 409 is recognised by the API's wording", () => {
    expect(
      userMutationErrorKind(
        new ApiError(
          409,
          "Cannot remove the last administrator who can sign in. Another administrator must sign in, or be promoted, first.",
        ),
      ),
    ).toBe("lastAdmin");
  });

  test("other failures fall through to the server's message", () => {
    expect(userMutationErrorKind(new ApiError(403, "You cannot change your own role"))).toBeNull();
    expect(userMutationErrorKind(new ApiError(409, "A record with this email already exists"))).toBeNull();
    expect(userMutationErrorKind(new ApiError(422, "x", { code: "OTHER" }))).toBeNull();
    expect(userMutationErrorKind(new Error("Failed to fetch"))).toBeNull();
  });
});
