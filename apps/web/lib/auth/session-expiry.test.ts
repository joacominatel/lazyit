import { describe, expect, test } from "bun:test";

import { safeInternalPath } from "@/lib/utils/safe-redirect";

import {
  expiredSessionLoginPath,
  mayBounceSignedInVisitor,
} from "./session-expiry";

/** Parse a relative /login path the way the /login page receives its search params. */
function loginParams(path: string): Record<string, string> {
  return Object.fromEntries(new URL(path, "http://lazyit.test").searchParams);
}

// #1307 — /login must never send a visitor whose API token was rejected back into the app, or the
// 401 handler and /login ping-pong until the cookie finally clears.
describe("mayBounceSignedInVisitor", () => {
  test("a plain /login visit by a signed-in user bounces into the app", () => {
    expect(mayBounceSignedInVisitor({})).toBe(true);
  });

  test("a visitor sent by the 401 handler is never bounced back", () => {
    const params = loginParams(
      expiredSessionLoginPath({ pathname: "/assets/abc", search: "?tab=history" }),
    );
    expect(mayBounceSignedInVisitor(params)).toBe(false);
  });

  test("any value of the marker holds the visitor on /login", () => {
    expect(mayBounceSignedInVisitor({ expired: "" })).toBe(false);
    expect(mayBounceSignedInVisitor({ expired: ["1", "1"] })).toBe(false);
  });
});

// The 401 fallback keeps the page the user was on, so signing in again returns them to it.
describe("expiredSessionLoginPath", () => {
  test("is a relative /login path (#1052)", () => {
    expect(
      expiredSessionLoginPath({ pathname: "/dashboard", search: "" }),
    ).toStartWith("/login?");
  });

  test("carries the current path and query as callbackUrl beside the marker", () => {
    const params = loginParams(
      expiredSessionLoginPath({
        pathname: "/assets/abc",
        search: "?tab=history&sort=desc",
      }),
    );
    expect(params).toEqual({
      expired: "1",
      callbackUrl: "/assets/abc?tab=history&sort=desc",
    });
    // /login feeds callbackUrl through the open-redirect guard; the carried value survives it intact.
    expect(safeInternalPath(params.callbackUrl)).toBe(
      "/assets/abc?tab=history&sort=desc",
    );
  });

  test("never carries the sign-in flow itself as the destination", () => {
    for (const [pathname, search] of [
      ["/login", ""],
      ["/login", "?expired=1&callbackUrl=%2Fassets"],
      ["/api/auth/callback/oidc", "?code=x"],
    ]) {
      expect(loginParams(expiredSessionLoginPath({ pathname, search }))).toEqual({
        expired: "1",
      });
    }
  });

  test("drops a destination the open-redirect guard would rewrite", () => {
    expect(
      loginParams(expiredSessionLoginPath({ pathname: "//evil.example", search: "" })),
    ).toEqual({ expired: "1" });
  });
});
