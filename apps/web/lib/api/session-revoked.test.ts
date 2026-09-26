import { describe, expect, test } from "bun:test";

import { ApiError } from "./client";
import { isSessionRevoked } from "./session-revoked";

describe("isSessionRevoked (#1420)", () => {
  test("a 401 with code SESSION_REVOKED", () => {
    expect(
      isSessionRevoked(
        new ApiError(401, "revoked", { statusCode: 401, code: "SESSION_REVOKED" }),
      ),
    ).toBe(true);
  });

  test("a plain 401 (wrong current password) is not", () => {
    expect(
      isSessionRevoked(new ApiError(401, "Unauthorized", { statusCode: 401 })),
    ).toBe(false);
    expect(isSessionRevoked(new ApiError(401, "Unauthorized"))).toBe(false);
  });

  test("the code on another status, or a non-API error, is not", () => {
    expect(
      isSessionRevoked(new ApiError(403, "x", { code: "SESSION_REVOKED" })),
    ).toBe(false);
    expect(isSessionRevoked(new Error("SESSION_REVOKED"))).toBe(false);
  });
});
