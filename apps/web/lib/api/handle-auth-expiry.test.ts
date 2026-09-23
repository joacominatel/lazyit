import { afterEach, beforeEach, expect, mock, test } from "bun:test";

/**
 * Unit tests for the global 401 auth-expiry reaction (issue #600).
 *
 * `handleAuthExpiry` is the single place that turns an expired-token 401 into a sign-out +
 * redirect. We can't reproduce a real IdP token expiry in a unit test, so we drive it with a
 * synthetic `ApiError(401)` and assert the contract that matters: it fires Auth.js's `signOut`
 * exactly once, ignores non-401 errors, and never fires while on an auth route (the loop-guard).
 *
 * `signOut` is mocked so nothing actually navigates; `window.location` is stubbed (with a spy on
 * `assign`) so the auth-route guard has a pathname to read and the post-sign-out relative redirect
 * (issue #1052) is observable under bun's happy-dom-less runtime.
 */

const signOut = mock(() => Promise.resolve(undefined));
mock.module("next-auth/react", () => ({ signOut }));

const assign = mock(() => undefined);

// `handleAuthExpiry` reads window.location.pathname/search and calls window.location.assign; stub them.
function setPathname(pathname: string, search = ""): void {
  // @ts-expect-error — minimal window stub for the guard under test.
  globalThis.window = { location: { pathname, search, assign } };
}

import { ApiError } from "./client";
import {
  __resetAuthExpiryLatch,
  handleAuthExpiry,
} from "./handle-auth-expiry";

beforeEach(() => {
  signOut.mockClear();
  assign.mockClear();
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

test("a 401 signs out exactly once and redirects to a relative, marked /login (#1052, #1307)", async () => {
  expect(handleAuthExpiry(new ApiError(401, "unauthorized"))).toBe(true);
  expect(signOut).toHaveBeenCalledTimes(1);
  // `redirect: false` keeps Auth.js from following the server-resolved absolute URL...
  expect(signOut).toHaveBeenCalledWith({ redirect: false });
  // ...and once the cookie is cleared we navigate client-side to the RELATIVE /login, carrying the
  // `expired` marker so /login cannot bounce a lingering cookie back into the app (#1307).
  await Promise.resolve();
  expect(assign).toHaveBeenCalledTimes(1);
  const [target] = assign.mock.calls[0] as unknown as [string];
  expect(target).toStartWith("/login?");
  expect(new URL(target, "http://lazyit.test").searchParams.get("expired")).toBe("1");
});

test("a 401 carries the page the user was on as callbackUrl (#1307)", async () => {
  setPathname("/assets/abc", "?tab=history");
  handleAuthExpiry(new ApiError(401, "unauthorized"));
  await Promise.resolve();
  const [target] = assign.mock.calls[0] as unknown as [string];
  const params = new URL(target, "http://lazyit.test").searchParams;
  expect(params.get("expired")).toBe("1");
  expect(params.get("callbackUrl")).toBe("/assets/abc?tab=history");
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
