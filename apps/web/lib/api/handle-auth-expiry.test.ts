import { afterEach, beforeEach, expect, mock, test } from "bun:test";

/**
 * Unit tests for the global 401 auth-expiry reaction (issue #600).
 *
 * `handleAuthExpiry` is the single place that turns an expired-token 401 into a sign-out +
 * redirect. We can't reproduce a real IdP token expiry in a unit test, so we drive it with a
 * synthetic `ApiError(401)` and assert the contract that matters: it fires Auth.js's `signOut`
 * exactly once, ignores non-401 errors, and never fires while on an auth route (the loop-guard).
 *
 * `signOut` is mocked so nothing actually navigates; `window.location` is stubbed so the
 * auth-route guard has a pathname to read under bun's happy-dom-less runtime.
 */

const signOut = mock(() => Promise.resolve(undefined));
mock.module("next-auth/react", () => ({ signOut }));

// `handleAuthExpiry` reads window.location.pathname; provide a writable stub.
function setPathname(pathname: string): void {
  // @ts-expect-error — minimal window stub for the guard under test.
  globalThis.window = { location: { pathname } };
}

import { ApiError } from "./client";
import {
  __resetAuthExpiryLatch,
  handleAuthExpiry,
} from "./handle-auth-expiry";

beforeEach(() => {
  signOut.mockClear();
  __resetAuthExpiryLatch();
  setPathname("/dashboard");
});

afterEach(() => {
  // @ts-expect-error — clear the stub between tests.
  delete globalThis.window;
});

test("ignores non-ApiError values", () => {
  expect(handleAuthExpiry(new Error("boom"))).toBe(false);
  expect(signOut).not.toHaveBeenCalled();
});

test("ignores non-401 ApiErrors", () => {
  expect(handleAuthExpiry(new ApiError(500, "server error"))).toBe(false);
  expect(signOut).not.toHaveBeenCalled();
});

test("a 401 signs out exactly once and redirects to /login", () => {
  expect(handleAuthExpiry(new ApiError(401, "unauthorized"))).toBe(true);
  expect(signOut).toHaveBeenCalledTimes(1);
  expect(signOut).toHaveBeenCalledWith({ callbackUrl: "/login" });
});

test("concurrent 401s only trigger one sign-out (latch)", () => {
  handleAuthExpiry(new ApiError(401, "unauthorized"));
  handleAuthExpiry(new ApiError(401, "unauthorized"));
  handleAuthExpiry(new ApiError(401, "unauthorized"));
  expect(signOut).toHaveBeenCalledTimes(1);
});

test("a 401 on an auth route does not sign out (loop-guard)", () => {
  setPathname("/login");
  expect(handleAuthExpiry(new ApiError(401, "unauthorized"))).toBe(true);
  expect(signOut).not.toHaveBeenCalled();

  setPathname("/api/auth/callback/oidc");
  expect(handleAuthExpiry(new ApiError(401, "unauthorized"))).toBe(true);
  expect(signOut).not.toHaveBeenCalled();
});
