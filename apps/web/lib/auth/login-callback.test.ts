import { describe, expect, test } from "bun:test";
import { safeInternalPath } from "@/lib/utils/safe-redirect";
import { loginCallbackPath } from "./login-callback";

function callbackOf(path: string): string | null {
  return new URL(path, "https://it.acme.io").searchParams.get("callbackUrl");
}

describe("loginCallbackPath", () => {
  test("keeps the query string, so the OAuth consent request survives sign-in", () => {
    const search =
      "?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fcallback&code_challenge=xyz&code_challenge_method=S256&state=s%26t";
    const path = loginCallbackPath({ pathname: "/oauth/authorize", search });
    const callback = callbackOf(path);
    expect(callback).toBe(`/oauth/authorize${search}`);
    // /login's open-redirect guard lets it through intact.
    expect(safeInternalPath(callback)).toBe(`/oauth/authorize${search}`);
    // The nested query does not leak into /login's own parameters.
    const outer = new URL(path, "https://it.acme.io").searchParams;
    expect(outer.get("client_id")).toBeNull();
    expect(outer.get("state")).toBeNull();
  });

  test("a page without a query is unchanged from before", () => {
    expect(loginCallbackPath({ pathname: "/assets", search: "" })).toBe(
      "/login?callbackUrl=%2Fassets",
    );
  });

  test("an unsafe combination falls back to the path alone", () => {
    expect(
      callbackOf(loginCallbackPath({ pathname: "/assets", search: "?a=\n" })),
    ).toBe("/assets");
  });
});
