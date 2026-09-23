import { describe, expect, test } from "bun:test";

import {
  EXPIRED_SESSION_LOGIN_PATH,
  mayBounceSignedInVisitor,
} from "./session-expiry";

// #1307 — /login must never send a visitor whose API token was rejected back into the app, or the
// 401 handler and /login ping-pong until the cookie finally clears.
describe("mayBounceSignedInVisitor", () => {
  test("a plain /login visit by a signed-in user bounces into the app", () => {
    expect(mayBounceSignedInVisitor({})).toBe(true);
  });

  test("a visitor sent by the 401 handler is never bounced back", () => {
    const params = Object.fromEntries(
      new URL(EXPIRED_SESSION_LOGIN_PATH, "http://lazyit.test").searchParams,
    );
    expect(mayBounceSignedInVisitor(params)).toBe(false);
  });

  test("any value of the marker holds the visitor on /login", () => {
    expect(mayBounceSignedInVisitor({ expired: "" })).toBe(false);
    expect(mayBounceSignedInVisitor({ expired: ["1", "1"] })).toBe(false);
  });

  test("the 401 handler's destination is a relative /login path (#1052)", () => {
    expect(EXPIRED_SESSION_LOGIN_PATH.startsWith("/login?")).toBe(true);
  });
});
