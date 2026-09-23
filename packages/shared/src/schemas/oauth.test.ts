import { describe, expect, test } from "bun:test";
import {
  CreatePersonalTokenSchema,
  OAuthAuthorizeDecisionSchema,
  OAuthAuthorizeValidationSchema,
  OAuthGrantSchema,
  OAuthScopeParamSchema,
  PERSONAL_TOKEN_PREFIX,
  PersonalTokenCreatedSchema,
  formatOAuthScopes,
} from "./oauth";

// OAuth 2.1 for MCP and personal tokens (ADR-0097 decisions 8 and 9; R7).

describe("Scope parameter parsing (RFC 6749 §3.3)", () => {
  test("parses a space-delimited list into catalog order, de-duplicated", () => {
    expect(OAuthScopeParamSchema.parse("lazyit.write lazyit.read lazyit.write")).toEqual([
      "lazyit.read",
      "lazyit.write",
    ]);
  });

  test("tolerates repeated spaces", () => {
    expect(OAuthScopeParamSchema.parse("  lazyit.read   lazyit.admin ")).toEqual([
      "lazyit.read",
      "lazyit.admin",
    ]);
  });

  test("refuses an empty value", () => {
    expect(OAuthScopeParamSchema.safeParse("").success).toBe(false);
    expect(OAuthScopeParamSchema.safeParse("   ").success).toBe(false);
  });

  test("refuses any unknown scope instead of narrowing silently", () => {
    expect(OAuthScopeParamSchema.safeParse("lazyit.read openid").success).toBe(false);
    expect(OAuthScopeParamSchema.safeParse("lazyit:read").success).toBe(false);
  });

  test("formats back to the parameter form", () => {
    expect(formatOAuthScopes(["lazyit.admin", "lazyit.read"])).toBe("lazyit.read lazyit.admin");
  });
});

describe("Consent validation (discriminated on ok)", () => {
  test("accepts the consent-screen shape", () => {
    expect(
      OAuthAuthorizeValidationSchema.safeParse({
        ok: true,
        client: { id: "https://claude.ai/oauth/client.json", name: "Claude Code", uri: null, verified: true },
        redirectUri: "http://127.0.0.1:33418/callback",
        redirectHost: "127.0.0.1",
        loopbackOnly: true,
        scopes: ["lazyit.read", "lazyit.write"],
        user: { email: "ana@example.com" },
      }).success,
    ).toBe(true);
  });

  test("accepts a typed refusal and rejects an unknown one", () => {
    expect(
      OAuthAuthorizeValidationSchema.safeParse({ ok: false, refusal: "INVALID_REDIRECT" }).success,
    ).toBe(true);
    expect(
      OAuthAuthorizeValidationSchema.safeParse({ ok: false, refusal: "NOPE" }).success,
    ).toBe(false);
  });

  test("rejects an unknown discriminant", () => {
    expect(OAuthAuthorizeValidationSchema.safeParse({ ok: "yes" }).success).toBe(false);
  });
});

describe("Consent decision", () => {
  const params = {
    response_type: "code",
    client_id: "lzc_abc",
    redirect_uri: "http://127.0.0.1:1234/cb",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
  };

  test("accepts an approval with scopes and an optional step-up password", () => {
    expect(
      OAuthAuthorizeDecisionSchema.safeParse({
        params,
        decision: "approve",
        scopes: ["lazyit.read", "lazyit.admin"],
        password: "correct horse",
      }).success,
    ).toBe(true);
  });

  test("refuses an unknown scope", () => {
    expect(
      OAuthAuthorizeDecisionSchema.safeParse({ params, decision: "approve", scopes: ["openid"] })
        .success,
    ).toBe(false);
  });
});

describe("Personal tokens (lan only)", () => {
  test("expiry defaults to 90 days and is capped at 365; there is no never-expiring token", () => {
    expect(CreatePersonalTokenSchema.parse({ label: "laptop" }).expiresInDays).toBe(90);
    expect(CreatePersonalTokenSchema.safeParse({ label: "x", expiresInDays: 366 }).success).toBe(
      false,
    );
    expect(CreatePersonalTokenSchema.safeParse({ label: "x", expiresInDays: 0 }).success).toBe(
      false,
    );
    expect(CreatePersonalTokenSchema.safeParse({ label: "x", expiresInDays: null }).success).toBe(
      false,
    );
  });

  test("the minted token carries the personal prefix", () => {
    const grant = {
      id: "ckgrant000000000000000000",
      kind: "personal",
      client: null,
      label: "laptop",
      redirectHost: null,
      scopes: ["lazyit.read", "lazyit.write"],
      createdAt: "2026-09-23T10:00:00.000Z",
      lastUsedAt: null,
      expiresAt: "2026-12-22T10:00:00.000Z",
    };
    expect(OAuthGrantSchema.safeParse(grant).success).toBe(true);
    expect(
      PersonalTokenCreatedSchema.safeParse({ token: `${PERSONAL_TOKEN_PREFIX}abc`, grant }).success,
    ).toBe(true);
    expect(PersonalTokenCreatedSchema.safeParse({ token: "lzit_oat_abc", grant }).success).toBe(
      false,
    );
  });

  test("a grant never exposes a token hash", () => {
    expect("tokenHash" in OAuthGrantSchema.shape).toBe(false);
  });
});
