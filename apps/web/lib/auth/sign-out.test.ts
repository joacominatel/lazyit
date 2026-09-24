import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";

/**
 * A user-initiated sign-out revokes the session server-side before dropping the cookie (#1307,
 * ADR-0086 §8), and never lets the API keep the user signed in. `signOut` is mocked and `fetch` /
 * `window.location` are stubbed, so the real `logout` endpoint call is observable without a network.
 */

const calls: string[] = [];

const signOut = mock(() => {
  calls.push("signOut");
  return Promise.resolve(undefined);
});
mock.module("next-auth/react", () => ({ signOut }));

const assign = mock((path: string) => {
  calls.push(`assign ${path}`);
});

const realFetch = globalThis.fetch;
let fetchImpl: (input: unknown, init?: RequestInit) => Promise<Response>;
const sent: Array<{ url: string; method?: string; authorization?: string }> = [];

import { setSessionToken } from "@/lib/api/session-token";

import { signOutAndRevoke } from "./sign-out";

beforeEach(() => {
  calls.length = 0;
  sent.length = 0;
  signOut.mockClear();
  // @ts-expect-error — minimal window stub: the token store and the navigation read it.
  globalThis.window = { location: { pathname: "/dashboard", assign } };
  setSessionToken("session-token");
  globalThis.fetch = Object.assign(
    (input: unknown, init?: RequestInit) => {
      sent.push({
        url: String(input),
        method: init?.method,
        authorization: new Headers(init?.headers).get("authorization") ?? undefined,
      });
      calls.push("logout");
      return fetchImpl(input, init);
    },
    { preconnect: realFetch.preconnect },
  ) as unknown as typeof fetch;
});

afterEach(() => {
  // @ts-expect-error — clear the stub between tests.
  delete globalThis.window;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

test("revokes the session with the current Bearer, then signs out and lands on /login", async () => {
  fetchImpl = () => Promise.resolve(new Response(null, { status: 204 }));
  await signOutAndRevoke();

  expect(sent).toHaveLength(1);
  expect(sent[0]?.url.endsWith("/auth/logout")).toBe(true);
  expect(sent[0]?.method).toBe("POST");
  expect(sent[0]?.authorization).toBe("Bearer session-token");
  expect(signOut).toHaveBeenCalledWith({ redirect: false });
  expect(calls).toEqual(["logout", "signOut", "assign /login"]);
});

test("an already-revoked token (401) still signs out", async () => {
  fetchImpl = () =>
    Promise.resolve(Response.json({ message: "Session has been revoked" }, { status: 401 }));
  await signOutAndRevoke();
  expect(calls).toEqual(["logout", "signOut", "assign /login"]);
});

test("an unreachable API never blocks signing out", async () => {
  fetchImpl = () => Promise.reject(new TypeError("fetch failed"));
  await signOutAndRevoke();
  expect(calls).toEqual(["logout", "signOut", "assign /login"]);
});

test("lands on the given sign-in path (the consent page returns to its own request)", async () => {
  fetchImpl = () => Promise.resolve(new Response(null, { status: 204 }));
  await signOutAndRevoke("/login?callbackUrl=%2Foauth%2Fauthorize%3Fclient_id%3Dabc");
  expect(calls).toEqual([
    "logout",
    "signOut",
    "assign /login?callbackUrl=%2Foauth%2Fauthorize%3Fclient_id%3Dabc",
  ]);
});
