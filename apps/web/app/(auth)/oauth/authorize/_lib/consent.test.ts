import { describe, expect, test } from "bun:test";
import { ApiError } from "@/lib/api/client";
import {
  classifyDecisionError,
  classifyDecisionSuccess,
  classifyValidateError,
  consentChoices,
  isRedirectToClient,
  readAuthorizeParams,
  redirectTrustLabel,
  scopesToGrant,
} from "./consent";

const LOOPBACK = "http://127.0.0.1:53682/callback";

describe("readAuthorizeParams", () => {
  test("forwards only the known OAuth keys", () => {
    const result = readAuthorizeParams({
      response_type: "code",
      client_id: "abc",
      redirect_uri: LOOPBACK,
      code_challenge: "x".repeat(43),
      code_challenge_method: "S256",
      state: "s1",
      scope: "lazyit.read lazyit.write",
      resource: "https://it.acme.io/mcp",
      prompt: "none",
      evil: "1",
    });
    expect(result).toEqual({
      ok: true,
      params: {
        response_type: "code",
        client_id: "abc",
        redirect_uri: LOOPBACK,
        code_challenge: "x".repeat(43),
        code_challenge_method: "S256",
        state: "s1",
        scope: "lazyit.read lazyit.write",
        resource: "https://it.acme.io/mcp",
      },
    });
  });

  test("a repeated parameter is refused (RFC 6749 §3.1)", () => {
    expect(
      readAuthorizeParams({ client_id: ["a", "b"], redirect_uri: LOOPBACK }),
    ).toEqual({ ok: false, reason: "repeated" });
  });

  test("missing parameters are left for the API to judge", () => {
    expect(readAuthorizeParams({ client_id: "abc" })).toEqual({
      ok: true,
      params: { client_id: "abc" } as never,
    });
  });
});

describe("consentChoices / scopesToGrant", () => {
  test("read & write requested: write preselected, admin not offered", () => {
    expect(consentChoices(["lazyit.read", "lazyit.write"])).toEqual({
      levels: ["read", "write"],
      defaultLevel: "write",
      adminOffered: false,
    });
  });

  test("admin is offered only when requested and never preselected", () => {
    const choices = consentChoices(["lazyit.read", "lazyit.write", "lazyit.admin"]);
    expect(choices.adminOffered).toBe(true);
    expect(choices.defaultLevel).toBe("write");
    expect(
      scopesToGrant(["lazyit.read", "lazyit.write", "lazyit.admin"], "write", false),
    ).toEqual(["lazyit.read", "lazyit.write"]);
    expect(
      scopesToGrant(["lazyit.read", "lazyit.write", "lazyit.admin"], "read", true),
    ).toEqual(["lazyit.read", "lazyit.admin"]);
  });

  test("never grants beyond the request", () => {
    expect(scopesToGrant(["lazyit.read"], "write", true)).toEqual(["lazyit.read"]);
    expect(scopesToGrant(["lazyit.write"], "read", false)).toEqual([]);
    expect(scopesToGrant(["lazyit.admin"], null, true)).toEqual(["lazyit.admin"]);
    expect(consentChoices(["lazyit.admin"])).toEqual({
      levels: [],
      defaultLevel: null,
      adminOffered: true,
    });
  });
});

describe("isRedirectToClient", () => {
  test("accepts the registered redirect with a query", () => {
    expect(isRedirectToClient(`${LOOPBACK}?code=c&state=s&iss=x`, LOOPBACK)).toBe(
      true,
    );
    expect(
      isRedirectToClient(
        "https://claude.ai/api/mcp/auth_callback?error=access_denied",
        "https://claude.ai/api/mcp/auth_callback",
      ),
    ).toBe(true);
  });

  test("accepts a custom scheme (Cursor)", () => {
    const cursor = "cursor://anysphere.cursor-mcp/oauth/callback";
    expect(isRedirectToClient(`${cursor}?code=c`, cursor)).toBe(true);
  });

  test("refuses another host, port, path or scheme", () => {
    expect(isRedirectToClient("https://evil.example/callback?code=c", LOOPBACK)).toBe(
      false,
    );
    expect(
      isRedirectToClient("http://127.0.0.1:1/callback?code=c", LOOPBACK),
    ).toBe(false);
    expect(isRedirectToClient("http://127.0.0.1:53682/other", LOOPBACK)).toBe(
      false,
    );
    expect(isRedirectToClient("https://127.0.0.1:53682/callback", LOOPBACK)).toBe(
      false,
    );
  });

  test("refuses script-capable schemes, userinfo, fragments and junk", () => {
    expect(isRedirectToClient("javascript:alert(1)", "javascript:alert(1)")).toBe(
      false,
    );
    expect(isRedirectToClient("data:text/html,x", "data:text/html,x")).toBe(false);
    expect(
      isRedirectToClient("http://u:p@127.0.0.1:53682/callback", LOOPBACK),
    ).toBe(false);
    expect(isRedirectToClient(`${LOOPBACK}#frag`, LOOPBACK)).toBe(false);
    expect(isRedirectToClient("not a url", LOOPBACK)).toBe(false);
    expect(isRedirectToClient(42, LOOPBACK)).toBe(false);
    expect(isRedirectToClient(LOOPBACK, undefined)).toBe(false);
  });
});

describe("classifyValidateError", () => {
  test("404 → no authorization server on this instance", () => {
    expect(classifyValidateError(new ApiError(404, "nf"), LOOPBACK)).toEqual({
      kind: "unavailable",
    });
  });

  test("400 with a client redirect → an offered (not followed) way back", () => {
    const err = new ApiError(400, "bad", {
      error: "invalid_scope",
      redirectTo: `${LOOPBACK}?error=invalid_scope&state=s`,
    });
    expect(classifyValidateError(err, LOOPBACK)).toEqual({
      kind: "client-error",
      error: "invalid_scope",
      redirectTo: `${LOOPBACK}?error=invalid_scope&state=s`,
    });
  });

  test("400 whose redirect is not the client's → an error page only", () => {
    const err = new ApiError(400, "bad", {
      error: "invalid_scope",
      redirectTo: "https://evil.example/?error=x",
    });
    expect(classifyValidateError(err, LOOPBACK)).toEqual({
      kind: "invalid-request",
    });
    expect(
      classifyValidateError(new ApiError(400, "bad", { error: "invalid_request" }), LOOPBACK),
    ).toEqual({ kind: "invalid-request" });
  });

  test("401, forced password change, others", () => {
    expect(classifyValidateError(new ApiError(401, "x"), LOOPBACK)).toEqual({
      kind: "auth",
    });
    expect(
      classifyValidateError(
        new ApiError(403, "x", { code: "PASSWORD_CHANGE_REQUIRED" }),
        LOOPBACK,
      ),
    ).toEqual({ kind: "password-change" });
    expect(
      classifyValidateError(new ApiError(500, "x", undefined, "req-1"), LOOPBACK),
    ).toEqual({ kind: "unknown", requestId: "req-1" });
    expect(classifyValidateError(new Error("net"), LOOPBACK)).toEqual({
      kind: "unknown",
    });
  });
});

describe("classifyDecision", () => {
  test("a success redirect is followed only when it points back at the client", () => {
    expect(
      classifyDecisionSuccess({ redirectTo: `${LOOPBACK}?code=c` }, LOOPBACK),
    ).toEqual({ kind: "redirect", redirectTo: `${LOOPBACK}?code=c` });
    expect(
      classifyDecisionSuccess({ redirectTo: "https://evil.example/" }, LOOPBACK),
    ).toEqual({ kind: "unsafe-redirect" });
    expect(classifyDecisionSuccess(null, LOOPBACK)).toEqual({
      kind: "unsafe-redirect",
    });
  });

  test("400 { error, redirectTo } → back to the client", () => {
    const err = new ApiError(400, "x", {
      error: "invalid_request",
      redirectTo: `${LOOPBACK}?error=invalid_request`,
    });
    expect(classifyDecisionError(err, LOOPBACK)).toEqual({
      kind: "redirect",
      redirectTo: `${LOOPBACK}?error=invalid_request`,
    });
  });

  test("403 refusals and step-up codes are never a logout", () => {
    expect(
      classifyDecisionError(new ApiError(403, "x", { refusal: "AI_DISABLED" }), LOOPBACK),
    ).toEqual({ kind: "refusal", refusal: "AI_DISABLED" });
    expect(
      classifyDecisionError(new ApiError(403, "x", { code: "STEP_UP_REQUIRED" }), LOOPBACK),
    ).toEqual({ kind: "step-up-required" });
    expect(
      classifyDecisionError(new ApiError(403, "x", { code: "STEP_UP_FAILED" }), LOOPBACK),
    ).toEqual({ kind: "step-up-failed" });
    expect(
      classifyDecisionError(
        new ApiError(403, "x", { code: "STEP_UP_UNAVAILABLE" }),
        LOOPBACK,
      ),
    ).toEqual({ kind: "step-up-unavailable" });
    expect(
      classifyDecisionError(new ApiError(403, "x", { refusal: "NOPE" }), LOOPBACK),
    ).toEqual({ kind: "unknown", requestId: undefined });
  });

  test("429 and the rest", () => {
    expect(classifyDecisionError(new ApiError(429, "x"), LOOPBACK)).toEqual({
      kind: "rate-limited",
    });
    expect(
      classifyDecisionError(new ApiError(500, "x", undefined, "r"), LOOPBACK),
    ).toEqual({ kind: "unknown", requestId: "r" });
  });
});

describe("redirectTrustLabel", () => {
  test("http(s): the host (with port)", () => {
    expect(redirectTrustLabel(LOOPBACK, "127.0.0.1")).toBe("127.0.0.1:53682");
    expect(
      redirectTrustLabel("https://claude.ai/api/mcp/auth_callback", "claude.ai"),
    ).toBe("claude.ai");
  });

  test("a custom scheme shows the scheme with its host", () => {
    expect(
      redirectTrustLabel(
        "cursor://anysphere.cursor-mcp/oauth/callback",
        "anysphere.cursor-mcp",
      ),
    ).toBe("cursor:// (anysphere.cursor-mcp)");
    expect(redirectTrustLabel("com.example.app:/callback", "")).toBe(
      "com.example.app://",
    );
  });

  test("unparseable → the API's host", () => {
    expect(redirectTrustLabel("::::", "example.org")).toBe("example.org");
  });
});
