import { expect, test } from "bun:test";
import { ApiError } from "@/lib/api/client";
import { grantExpiryMinDate, isExpiryBeforeGrantedError } from "./grant-expiry";

test("the picker minimum is the grantedAt day in UTC", () => {
  expect(grantExpiryMinDate("2026-10-14T15:30:00.000Z")).toBe("2026-10-14");
  expect(grantExpiryMinDate("2026-10-14T23:59:59.999Z")).toBe("2026-10-14");
  expect(grantExpiryMinDate("2026-10-14T00:00:00.000Z")).toBe("2026-10-14");
});

test("recognises the API's expiry-before-grantedAt refusal", () => {
  expect(
    isExpiryBeforeGrantedError(
      new ApiError(400, "expiresAt must be on or after grantedAt"),
    ),
  ).toBe(true);
});

test("leaves every other failure to the generic toast", () => {
  expect(isExpiryBeforeGrantedError(new ApiError(400, "Validation failed"))).toBe(false);
  expect(
    isExpiryBeforeGrantedError(
      new ApiError(409, "expiresAt must be on or after grantedAt"),
    ),
  ).toBe(false);
  expect(isExpiryBeforeGrantedError(new ApiError(404, "AccessGrant not found"))).toBe(false);
  expect(
    isExpiryBeforeGrantedError(new Error("expiresAt must be on or after grantedAt")),
  ).toBe(false);
});
