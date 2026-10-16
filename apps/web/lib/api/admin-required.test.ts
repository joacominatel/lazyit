import { describe, expect, test } from "bun:test";
import { isAdminRequired } from "./admin-required";
import { ApiError } from "./client";

describe("isAdminRequired", () => {
  test("recognises the AdminOnlyGuard 403 by its code", () => {
    const body = { statusCode: 403, code: "ADMIN_REQUIRED", message: "Only an administrator can do this." };
    expect(isAdminRequired(new ApiError(403, body.message, body))).toBe(true);
  });

  test("a plain permission 403, another status or a non-API error is not it", () => {
    expect(isAdminRequired(new ApiError(403, "Forbidden resource"))).toBe(false);
    expect(isAdminRequired(new ApiError(400, "x", { code: "ADMIN_REQUIRED" }))).toBe(false);
    expect(isAdminRequired(new Error("Failed to fetch"))).toBe(false);
  });
});
