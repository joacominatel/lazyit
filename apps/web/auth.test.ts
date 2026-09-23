import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

/**
 * Session lifetime in the Auth.js config (#1307, ADR-0086 §8, ADR-0039 §10).
 *
 * `auth.ts` hands its config to `NextAuth(...)` at import time. `NextAuth` is mocked to capture that
 * config, so the REAL `jwt` callback and Credentials `authorize` run here without an Auth.js runtime.
 * The global `fetch` is stubbed, so `authorize`'s real `apiFetch` call to `POST /auth/login` and the OIDC
 * refresh grant never touch the network. No app module is mocked: bun's `mock.module` is process-wide.
 */

type Config = {
  session: { maxAge?: number };
  providers: Array<{
    id?: string;
    authorize?: (raw: Record<string, unknown>) => Promise<unknown>;
  }>;
  callbacks: {
    jwt: (params: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  };
};

let captured: Config | undefined;

mock.module("next-auth", () => ({
  default: (config: Config) => {
    captured = config;
    return { handlers: {}, auth: () => null, signIn: () => {}, signOut: () => {} };
  },
  customFetch: Symbol("customFetch"),
}));
mock.module("next-auth/providers/credentials", () => ({
  default: (options: Record<string, unknown>) => ({ ...options, type: "credentials" }),
}));
mock.module("@/lib/auth/bootstrap-file", () => ({
  loadWebBootstrapOidcFile: () => {},
}));

// `auth.ts` captures the global `fetch` at import time for its OIDC refresh grant, so install a
// delegating stub BEFORE the import and swap what it delegates to per test.
const realFetch = globalThis.fetch;
let fetchImpl: (input: unknown, init?: RequestInit) => Promise<Response> = () =>
  Promise.reject(new Error("unexpected fetch"));
globalThis.fetch = Object.assign(
  (input: unknown, init?: RequestInit) => fetchImpl(input, init),
  { preconnect: realFetch.preconnect },
) as unknown as typeof fetch;

// No issuer → local mode, the mode this issue is about. Set before the import below evaluates auth.ts.
delete process.env.AUTH_ISSUER;
delete process.env.AUTH_INTERNAL_ISSUER;
await import("./auth");

function config(): Config {
  if (!captured) throw new Error("auth.ts did not call NextAuth");
  return captured;
}

const jwt = (params: Record<string, unknown>) => config().callbacks.jwt(params);
const nowSeconds = () => Math.floor(Date.now() / 1000);

afterEach(() => {
  fetchImpl = () => Promise.reject(new Error("unexpected fetch"));
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("cookie lifetime", () => {
  test("local mode keeps the cookie for the browser maximum (400 days) so remember-me outlives it", () => {
    expect(config().session.maxAge).toBe(400 * 24 * 60 * 60);
  });
});

describe("jwt callback — local sessions", () => {
  const signIn = (expiresAt: number | null) =>
    jwt({
      token: { name: "Alice" },
      user: { name: "Alice", email: "a@x", accessToken: "local-token", expiresAt },
      account: { type: "credentials", provider: "credentials" },
      trigger: "signIn",
    });

  test("records the token expiry on a default sign-in", async () => {
    const exp = nowSeconds() + 12 * 60 * 60;
    expect(await signIn(exp)).toMatchObject({ accessToken: "local-token", expiresAt: exp });
  });

  test("a default session is ended once its token has expired", async () => {
    const token = { accessToken: "local-token", expiresAt: nowSeconds() - 1 };
    expect(await jwt({ token })).toBeNull();
  });

  test("a default session still inside its lifetime is kept", async () => {
    const token = { accessToken: "local-token", expiresAt: nowSeconds() + 3600 };
    expect(await jwt({ token })).toEqual(token);
  });

  test("a remember-me session records no expiry and is never ended by time", async () => {
    const token = await signIn(null);
    expect(token).not.toBeNull();
    expect(token?.expiresAt).toBeUndefined();
    // Long after any 12h window, it is still a session.
    expect(await jwt({ token: { ...token } })).toMatchObject({ accessToken: "local-token" });
  });

  test("a legacy cookie without expiresAt (issued before #1307) is tolerated, not ended", async () => {
    const legacy = { name: "Alice", accessToken: "old-local-token" };
    expect(await jwt({ token: { ...legacy } })).toEqual(legacy);
  });
});

describe('jwt callback — trigger: "update" (change password)', () => {
  test("carries the re-minted token and its expiry", async () => {
    const exp = nowSeconds() + 12 * 60 * 60;
    const token = await jwt({
      token: { accessToken: "old", expiresAt: nowSeconds() + 60 },
      trigger: "update",
      session: { accessToken: "new", expiresAt: exp },
    });
    expect(token).toMatchObject({ accessToken: "new", expiresAt: exp });
  });

  test("a remember-me re-mint (expiresAt: null) clears the recorded expiry", async () => {
    const token = await jwt({
      token: { accessToken: "old", expiresAt: nowSeconds() + 60 },
      trigger: "update",
      session: { accessToken: "new", expiresAt: null },
    });
    expect(token?.accessToken).toBe("new");
    expect(token?.expiresAt).toBeUndefined();
  });

  test("an update without a token changes nothing", async () => {
    const original = { accessToken: "old", expiresAt: 123 };
    expect(
      await jwt({ token: { ...original }, trigger: "update", session: { expiresAt: null } }),
    ).toEqual(original);
  });
});

describe("jwt callback — OIDC", () => {
  // The IdP rejects the refresh grant (revoked / idle-expired refresh token).
  function stubFailingRefresh(): void {
    fetchImpl = (input) =>
      Promise.resolve(
        String(input).includes("openid-configuration")
          ? Response.json({ token_endpoint: "https://idp.example/token" })
          : Response.json({ error: "invalid_grant" }, { status: 400 }),
      );
  }

  function stubSuccessfulRefresh(): void {
    fetchImpl = (input) =>
      Promise.resolve(
        String(input).includes("openid-configuration")
          ? Response.json({ token_endpoint: "https://idp.example/token" })
          : Response.json({ access_token: "fresh", expires_in: 3600, refresh_token: "rt-2" }),
      );
  }

  // The refresh helper logs its failure; keep the test output clean.
  const realConsoleError = console.error;
  beforeEach(() => {
    console.error = () => {};
  });
  afterEach(() => {
    console.error = realConsoleError;
  });

  test("an expired token with a failed refresh ends the session", async () => {
    stubFailingRefresh();
    const token = { accessToken: "stale", expiresAt: nowSeconds() - 10, refreshToken: "rt" };
    expect(await jwt({ token })).toBeNull();
  });

  test("an expired token with no refresh token ends the session", async () => {
    const token = { accessToken: "stale", expiresAt: nowSeconds() - 10 };
    expect(await jwt({ token })).toBeNull();
  });

  test("a failed refresh inside the skew window keeps the still-valid token and flags the error", async () => {
    stubFailingRefresh();
    const token = { accessToken: "valid", expiresAt: nowSeconds() + 10, refreshToken: "rt" };
    expect(await jwt({ token })).toMatchObject({
      accessToken: "valid",
      error: "RefreshAccessTokenError",
    });
  });

  test("a successful refresh rotates the tokens", async () => {
    stubSuccessfulRefresh();
    const token = { accessToken: "stale", expiresAt: nowSeconds() - 10, refreshToken: "rt" };
    expect(await jwt({ token })).toMatchObject({ accessToken: "fresh", refreshToken: "rt-2" });
  });
});
