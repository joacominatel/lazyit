import { afterEach, beforeEach, expect, mock, test } from "bun:test";

/**
 * Unit tests for the global forced-password-change reaction (ADR-0086 §F4b, control 2).
 *
 * `handlePasswordChangeRequired` turns the API's `403 { code: 'PASSWORD_CHANGE_REQUIRED' }` into a hard
 * navigation to the `/change-password` wall. We drive it with synthetic `ApiError`s and assert the
 * contract: it fires exactly one navigation, only for that exact 403 code, ignores everything else, and
 * never navigates while already on the wall (the loop-guard).
 *
 * `window.location` is stubbed with a mock `assign` + a writable `pathname` under bun's happy-dom-less
 * runtime.
 */

const assign = mock(() => undefined);

function setPathname(pathname: string): void {
  // @ts-expect-error — minimal window stub for the guard under test.
  globalThis.window = { location: { pathname, assign } };
}

import { ApiError } from "./client";
import {
  __resetPasswordChangeLatch,
  handlePasswordChangeRequired,
} from "./handle-password-change-required";

const forcedError = () =>
  new ApiError(403, "must change", { code: "PASSWORD_CHANGE_REQUIRED" });

beforeEach(() => {
  assign.mockClear();
  __resetPasswordChangeLatch();
  setPathname("/dashboard");
});

afterEach(() => {
  // @ts-expect-error — clear the stub between tests.
  delete globalThis.window;
});

test("ignores non-ApiError values", () => {
  expect(handlePasswordChangeRequired(new Error("boom"))).toBe(false);
  expect(assign).not.toHaveBeenCalled();
});

test("ignores a 403 without the PASSWORD_CHANGE_REQUIRED code", () => {
  expect(
    handlePasswordChangeRequired(new ApiError(403, "forbidden", { code: "OTHER" })),
  ).toBe(false);
  expect(assign).not.toHaveBeenCalled();
});

test("ignores a non-403 ApiError", () => {
  expect(handlePasswordChangeRequired(new ApiError(401, "unauthorized"))).toBe(false);
  expect(assign).not.toHaveBeenCalled();
});

test("the forced-change 403 navigates to /change-password exactly once", () => {
  expect(handlePasswordChangeRequired(forcedError())).toBe(true);
  expect(assign).toHaveBeenCalledTimes(1);
  expect(assign).toHaveBeenCalledWith("/change-password");
});

test("concurrent forced-change 403s only trigger one navigation (latch)", () => {
  handlePasswordChangeRequired(forcedError());
  handlePasswordChangeRequired(forcedError());
  handlePasswordChangeRequired(forcedError());
  expect(assign).toHaveBeenCalledTimes(1);
});

test("does not navigate when already on the /change-password wall (loop-guard)", () => {
  setPathname("/change-password");
  expect(handlePasswordChangeRequired(forcedError())).toBe(true);
  expect(assign).not.toHaveBeenCalled();
});
