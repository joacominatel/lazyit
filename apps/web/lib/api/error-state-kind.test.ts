import { expect, test } from "bun:test";
import { ApiError } from "./client";
import { errorStateKind } from "./error-state-kind";

test("a 401 classifies as 'auth' (session expiry, redirect owns the UI)", () => {
  expect(errorStateKind(new ApiError(401, "unauthorized"))).toBe("auth");
});

test("a 403 classifies as 'forbidden' (real permission denial)", () => {
  expect(errorStateKind(new ApiError(403, "forbidden"))).toBe("forbidden");
});

test("a 500 classifies as 'retry' (transient, safe to retry)", () => {
  expect(errorStateKind(new ApiError(500, "server error"))).toBe("retry");
});

test("a non-ApiError (network failure) classifies as 'retry'", () => {
  expect(errorStateKind(new TypeError("Failed to fetch"))).toBe("retry");
});
