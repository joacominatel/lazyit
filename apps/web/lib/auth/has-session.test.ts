import { describe, expect, test } from "bun:test";
import type { Session } from "next-auth";

import { hasSession } from "./has-session";

// #1399 / SEC-079 (GHSA-8fpg-xm3f-6cx3): a truthy `auth()` result is not a session. Under a server
// configuration error, next-auth <= beta.31 returned the endpoint's error body, and a plain
// `if (!session)` guard let an anonymous visitor through.
describe("hasSession", () => {
  test("a real session with a user passes", () => {
    const session = {
      user: { name: "Ada", email: "ada@example.com" },
      accessToken: "tok",
      expires: "2099-01-01T00:00:00.000Z",
    } as Session;
    expect(hasSession(session)).toBe(true);
  });

  test("no session fails", () => {
    expect(hasSession(null)).toBe(false);
    expect(hasSession(undefined)).toBe(false);
  });

  test("the Auth.js configuration-error body is not a session", () => {
    const configError = {
      message:
        "There was a problem with the server configuration. Check the server logs for more information.",
    } as unknown as Session;
    // Truthy, so an existence check would have granted access:
    expect(Boolean(configError)).toBe(true);
    expect(hasSession(configError)).toBe(false);
  });

  test("an object without a usable user fails", () => {
    expect(hasSession({ user: null } as unknown as Session)).toBe(false);
    expect(hasSession({ expires: "x" } as unknown as Session)).toBe(false);
  });
});
