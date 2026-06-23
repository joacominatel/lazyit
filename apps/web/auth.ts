/**
 * Auth.js v5 (next-auth@beta) configuration — ADR-0039.
 *
 * A single generic OIDC provider driven entirely by three environment variables:
 *   AUTH_ISSUER          — OIDC discovery base URL (e.g. https://auth.example.com)
 *   AUTH_CLIENT_ID       — OIDC client ID
 *   AUTH_CLIENT_SECRET   — OIDC client secret
 *
 * Optional Docker DNS workaround:
 *   AUTH_INTERNAL_ISSUER — Internal base URL reachable from within the Docker network
 *                          (e.g. http://zitadel:8080). When set, server-side OIDC calls
 *                          (discovery, token exchange, userinfo) have their request URL
 *                          rewritten from the external AUTH_ISSUER origin to this internal
 *                          origin, which may not resolve inside the container otherwise. The
 *                          browser-facing authorization redirect continues to use AUTH_ISSUER.
 *
 * The IdP is Zitadel by default (ADR-0037), but any OIDC-compliant provider works
 * with no code changes — BYOI by env vars.
 *
 * Session strategy: JWT (no DB session). The IdP's access token is stored in the
 * encrypted session cookie so the frontend can attach it as Bearer on API calls.
 * See ADR-0039 for the full rationale.
 */

import NextAuth, { customFetch } from "next-auth";
// Type-only import so the `next-auth/jwt` module is in the program and can be augmented
// below (the `jwt` callback's `token` is typed by this module's `JWT` interface).
import type {} from "next-auth/jwt";

import { loadWebBootstrapOidcFile } from "@/lib/auth/bootstrap-file";

// Zero-touch bootstrap (ADR-0043 Phase 3): before any AUTH_* read below, back-fill them from the
// sidecar's oidc-client.json (mounted read-only) for any var the operator did not set, so the
// bundled-Zitadel flow needs NO hand-copied client id/secret. Explicit AUTH_* env always wins; a
// Node-runtime-only, fail-soft no-op on Edge / when the file is absent (BYOI + `next build`).
loadWebBootstrapOidcFile();

declare module "next-auth" {
  interface Session {
    /** IdP access token, forwarded as `Authorization: Bearer` on API calls. */
    accessToken: string;
    /**
     * Set to `"RefreshAccessTokenError"` when a silent refresh failed (issue #658).
     * The stale `accessToken` is still attached, so the next API call 401s and the
     * existing global-401 handler (issue #657) signs the user out — this field is the
     * declared signal of that fallback, surfaced for any future proactive handling.
     */
    error?: "RefreshAccessTokenError";
  }
}

// The `jwt` callback's `token` parameter is typed by `next-auth/jwt`'s `JWT` interface
// (re-exported from `@auth/core/jwt`), NOT `next-auth`'s — so the refresh fields must be
// augmented here for the callback to see them as typed (otherwise they fall back to the
// `Record<string, unknown>` index signature and `token.refreshToken` is `unknown`).
declare module "next-auth/jwt" {
  interface JWT {
    /**
     * IdP access token, stored in the encrypted session cookie on first sign-in
     * so it can be forwarded to the API on every request (ADR-0039).
     */
    accessToken?: string;
    /**
     * Absolute access-token expiry, **seconds** since epoch (the OIDC `expires_at`
     * convention). Drives the refresh decision in the `jwt` callback. Absent when the
     * IdP returned no expiry — refresh is then skipped and the token behaves as before.
     */
    expiresAt?: number;
    /**
     * OIDC refresh token, granted via the `offline_access` scope. Used to mint a fresh
     * access token before expiry; rotated when the IdP returns a new one. Absent when the
     * IdP did not grant `offline_access` — the session then degrades to the #657 path.
     */
    refreshToken?: string;
    /** Set when a refresh attempt failed; mirrored onto `session.error` (issue #658). */
    error?: "RefreshAccessTokenError";
  }
}

/**
 * Refresh the access token this many seconds *before* its hard expiry, so an in-flight
 * request never races a same-instant expiry. ponytail: a fixed 30s skew (no jitter, no
 * per-request tuning) is plenty for a small single-org app; revisit only if the IdP issues
 * very short-lived tokens or refresh storms appear.
 */
const REFRESH_SKEW_SECONDS = 30;

const internalIssuer = process.env.AUTH_INTERNAL_ISSUER;
const externalIssuer = process.env.AUTH_ISSUER;

// Auth.js / oauth4webapi runs OIDC discovery, token exchange and userinfo server-side against
// the provider `issuer` and the endpoints in its discovery document — all at the external auth
// origin (e.g. https://auth.localhost:8443), which does NOT resolve inside the Docker network.
// When AUTH_INTERNAL_ISSUER is set, this wrapper rewrites those requests to the internal Docker
// origin (e.g. http://zitadel:8080) and sets X-Forwarded-* so Zitadel resolves the right instance
// and keeps emitting the canonical external issuer. The browser-facing authorization redirect is
// built from the discovery document and never passes through this fetch, so it stays external.
const forwardedFetch: typeof fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const ext = new URL(externalIssuer!);
    const int = new URL(internalIssuer!);
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.host === ext.host) {
      url.protocol = int.protocol;
      url.host = int.host;
    }
    const headers = new Headers(init?.headers);
    headers.set("X-Forwarded-Host", ext.host);
    headers.set("X-Forwarded-Proto", ext.protocol.replace(":", ""));
    return fetch(url, { ...init, headers });
  },
  // `typeof fetch` carries a `preconnect` member in this lib config; delegate to the global
  // so the wrapper structurally satisfies the type expected by Auth.js's customFetch slot.
  { preconnect: fetch.preconnect },
);

// Server-side fetch for our own OIDC calls (the refresh below). Reuses `forwardedFetch`'s
// external→internal origin rewrite when AUTH_INTERNAL_ISSUER is set (Docker), so the token
// endpoint is reachable from inside the network; otherwise plain global fetch.
const oidcServerFetch: typeof fetch = internalIssuer ? forwardedFetch : fetch;

/**
 * Refresh the OIDC access token using the stored refresh token (issue #658).
 *
 * The token endpoint is read from the provider's discovery document
 * (`{issuer}/.well-known/openid-configuration`) so this stays provider-agnostic (BYOI) —
 * no hard-coded Zitadel path. Discovery + token POST run server-side via `oidcServerFetch`
 * (honouring the Docker internal-issuer rewrite). Client auth uses `client_secret_post`
 * (client_id + secret in the body), which Zitadel's discovery advertises alongside basic;
 * this matches the confidential web client the provider is already configured as.
 *
 * Returns the refreshed token fields on success, or `{ error }` on any failure so the
 * caller can mark the JWT and let the #657 fallback take over. Never throws.
 */
async function refreshAccessToken(refreshToken: string): Promise<
  | { accessToken: string; expiresAt: number; refreshToken: string }
  | { error: "RefreshAccessTokenError" }
> {
  try {
    const discoveryUrl = `${externalIssuer}/.well-known/openid-configuration`;
    const discoveryRes = await oidcServerFetch(discoveryUrl);
    if (!discoveryRes.ok) throw new Error(`discovery ${discoveryRes.status}`);
    const { token_endpoint } = (await discoveryRes.json()) as {
      token_endpoint?: string;
    };
    if (!token_endpoint) throw new Error("no token_endpoint in discovery");

    const res = await oidcServerFetch(token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.AUTH_CLIENT_ID!,
        client_secret: process.env.AUTH_CLIENT_SECRET!,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    const tokens = (await res.json().catch(() => undefined)) as
      | { access_token?: string; expires_in?: number; refresh_token?: string }
      | undefined;
    if (!res.ok || !tokens?.access_token) {
      throw new Error(`token endpoint ${res.status}`);
    }

    return {
      accessToken: tokens.access_token,
      // `expires_in` is relative seconds; fall back to a 5-min floor if the IdP omits it
      // so we still re-attempt refresh on a sane cadence rather than treating it as eternal.
      expiresAt: Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 300),
      // Rotate to the new refresh_token when the IdP issues one; otherwise keep the current
      // one (some IdPs issue refresh_tokens only once).
      refreshToken: tokens.refresh_token ?? refreshToken,
    };
  } catch (error) {
    console.error("[auth] refresh_token grant failed", error);
    return { error: "RefreshAccessTokenError" };
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  /**
   * Generic OIDC provider. Auth.js runs discovery from `issuer`
   * (`{issuer}/.well-known/openid-configuration`) — no Zitadel-specific code.
   * BYOI: replace these three env vars to swap IdPs.
   *
   * When AUTH_INTERNAL_ISSUER is set, the custom fetch (above) rewrites server-side OIDC
   * request URLs from the external issuer origin to the internal Docker origin. We rely on
   * discovery + that rewriting fetch alone: oauth4webapi's discovery is driven by `issuer`,
   * so wellKnown / token / userinfo overrides would be ignored and only add confusion.
   */
  providers: [
    {
      id: "oidc",
      name: "Your organization",
      type: "oidc",
      issuer: externalIssuer,
      clientId: process.env.AUTH_CLIENT_ID,
      clientSecret: process.env.AUTH_CLIENT_SECRET,
      // Request the standard identity scopes so the IdP returns the user's
      // `name`/`email` claims — without this the provider asks for `openid` only
      // and `session.user.name` stays empty (the topbar shows "—"). NB: the IdP
      // (e.g. Zitadel) must also grant these scopes and emit the claims (for
      // Zitadel: enable "User Info inside ID Token" on the app) — see ADR-0037/0039.
      //
      // `offline_access` asks the IdP for a `refresh_token` so the `jwt` callback can
      // silently renew the access token before it expires (issue #658). Zitadel grants
      // it for confidential web clients. If the IdP does NOT return a refresh_token, the
      // refresh logic degrades gracefully to the existing #657 global-401 path — the
      // session is never broken by a missing refresh_token.
      authorization: { params: { scope: "openid profile email offline_access" } },
      // Map the OIDC standard claims to the Auth.js user. Fall back to
      // `preferred_username` / a `given_name + family_name` join when an IdP omits
      // the composite `name` claim, so the topbar never falls back to "—".
      profile(profile) {
        const fullName =
          profile.name ??
          [profile.given_name, profile.family_name]
            .filter(Boolean)
            .join(" ") ??
          profile.preferred_username ??
          null;
        return {
          id: profile.sub,
          name: fullName || profile.preferred_username || null,
          email: profile.email ?? null,
        };
      },
      ...(internalIssuer ? { [customFetch]: forwardedFetch } : {}),
    },
  ],

  session: {
    /** Stateless JWT session — no session DB required (ADR-0039). */
    strategy: "jwt",
  },

  callbacks: {
    /**
     * Drives the access-token lifecycle in the stateless JWT cookie (ADR-0039, issue #658).
     *
     * - Initial sign-in (`account` present): capture `access_token`, its `expires_at`
     *   (seconds since epoch, computed by Auth.js from `expires_in`) and the `refresh_token`
     *   (present only when the IdP granted `offline_access`). Missing fields degrade
     *   gracefully — we store what we got and never throw, so the session is never broken.
     * - Subsequent calls, token still valid (allowing for clock skew): return as-is.
     * - Subsequent calls, token expired/near-expiry AND we hold a refresh_token: refresh it
     *   against the IdP token endpoint and rotate the refresh_token if a new one is returned.
     * - No refresh_token (IdP didn't grant offline_access) or refresh failed: leave the stale
     *   token in place (and set `error` on failure). The next API call 401s and the existing
     *   global-401 handler (issue #657) signs the user out — the intended safety net.
     */
    async jwt({ token, account, user }) {
      // `user` is only present on the initial sign-in; persist identity on the token.
      if (user) {
        token.name = user.name ?? token.name;
        token.email = user.email ?? token.email;
      }

      // Initial sign-in: snapshot the tokens from the IdP's token response.
      if (account) {
        token.accessToken = account.access_token ?? token.accessToken;
        // `expires_at` is seconds since epoch (oauth4webapi normalises `expires_in`).
        token.expiresAt =
          typeof account.expires_at === "number"
            ? account.expires_at
            : undefined;
        token.refreshToken = account.refresh_token ?? undefined;
        delete token.error;
        return token;
      }

      // No expiry recorded → we can't time a refresh; behave as before (stale → #657).
      if (typeof token.expiresAt !== "number") return token;

      // Access token still valid (minus skew) → reuse it.
      if (Date.now() < (token.expiresAt - REFRESH_SKEW_SECONDS) * 1000) {
        return token;
      }

      // Expired/near-expiry. Without a refresh_token we can't renew → let it 401 (#657).
      if (!token.refreshToken) return token;

      const refreshed = await refreshAccessToken(token.refreshToken);
      if ("error" in refreshed) {
        // Keep the stale accessToken so the next API call still 401s and #657 fires.
        token.error = "RefreshAccessTokenError";
        return token;
      }

      token.accessToken = refreshed.accessToken;
      token.expiresAt = refreshed.expiresAt;
      token.refreshToken = refreshed.refreshToken;
      delete token.error;
      return token;
    },

    /**
     * Expose the access token AND the user identity on the client-side session
     * returned by `useSession()` / `auth()`. This callback overrides Auth.js's
     * default session shaping, so it must explicitly carry `name`/`email` from the
     * token onto `session.user` (the topbar `UserMenu` reads those).
     */
    session({ session, token }) {
      // token.accessToken / name / email / error are set in the jwt callback above.
      // The cast is required because the session callback's `token` type does not
      // automatically merge the augmented JWT interface in all TS configurations.
      const t = token as {
        accessToken?: string;
        name?: string | null;
        email?: string | null;
        error?: "RefreshAccessTokenError";
      };
      session.accessToken = t.accessToken ?? "";
      // Surface a failed refresh so a consumer can react proactively; the stale token also
      // still 401s, so the existing global-401 handler (issue #657) remains the safety net.
      session.error = t.error;
      if (session.user) {
        session.user.name = t.name ?? session.user.name;
        session.user.email = t.email ?? session.user.email;
      }
      return session;
    },
  },

  pages: {
    /** Custom login page — replaces Auth.js's built-in sign-in page. */
    signIn: "/login",
  },
});
