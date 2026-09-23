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
import Credentials from "next-auth/providers/credentials";
// Type-only import so the `next-auth/jwt` module is in the program and can be augmented
// below (the `jwt` callback's `token` is typed by this module's `JWT` interface).
import type {} from "next-auth/jwt";

import { LoginRequestSchema, type LoginResponse } from "@lazyit/shared";

import { apiFetch } from "@/lib/api/client";
import { loadWebBootstrapOidcFile } from "@/lib/auth/bootstrap-file";

// Zero-touch bootstrap (ADR-0043 Phase 3): before any AUTH_* read below, back-fill them from the
// sidecar's oidc-client.json (mounted read-only) for any var the operator did not set, so the
// bundled-Zitadel flow needs NO hand-copied client id/secret. Explicit AUTH_* env always wins; a
// Node-runtime-only, fail-soft no-op on Edge / when the file is absent (BYOI + `next build`).
loadWebBootstrapOidcFile();

declare module "next-auth" {
  interface User {
    /**
     * Set ONLY on a local (Credentials) sign-in (ADR-0086 §6): the first-party session token the API
     * minted in `POST /auth/login`. The `authorize` callback returns it here; the `jwt` callback moves
     * it onto `token.accessToken` (a local sign-in has no `account.access_token` to snapshot). OIDC
     * sign-ins never set this — they carry the token via `account.access_token`.
     */
    accessToken?: string;
    /**
     * Set ONLY on a local (Credentials) sign-in (#1307, ADR-0086 §8): when the API-minted token stops
     * being accepted by time, in SECONDS since the epoch, or `null` for a "keep me signed in" token with
     * no time-based expiry. The `jwt` callback moves it onto `token.expiresAt`.
     */
    expiresAt?: number | null;
  }
  interface Session {
    /** IdP access token, forwarded as `Authorization: Bearer` on API calls. */
    accessToken: string;
    /**
     * Set to `"RefreshAccessTokenError"` when a silent refresh failed (issue #658) while the
     * access token was still inside its skew window, so it is still valid and the refresh is
     * retried on the next read. A failure after expiry ends the session instead (#1307).
     * Surfaced for any future proactive handling.
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
     * convention). Drives the refresh decision in the `jwt` callback, and — once it has
     * passed and the token cannot be renewed — ends the session (#1307). A local sign-in
     * records the API-minted token's expiry here too (ADR-0086 §8). Absent when there is no
     * time-based expiry: an IdP that returned none, a "keep me signed in" local session, or a
     * cookie issued before #1307. Such a session is never ended by time here.
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

/**
 * Auth.js session-cookie lifetime (`session.maxAge`, seconds) — #1307, ADR-0086 §8.
 *
 * Local mode: 400 days, the ceiling browsers enforce on a cookie's lifetime (RFC 6265bis; Chromium
 * clamps anything longer). A "keep me signed in" session has no time-based expiry, so the cookie must
 * outlive it; under the JWT strategy Auth.js re-issues the cookie with a fresh `maxAge` on every session
 * read (each proxied request, each `/api/auth/session` poll — `updateAge` only applies to database
 * sessions), so an active user's cookie never lapses. The 12h limit of a default local session is NOT
 * the cookie's job: the `jwt` callback ends the session once the recorded `expiresAt` passes.
 *
 * OIDC mode (an issuer is configured): Auth.js's own 30-day default, unchanged. An IdP session is renewed
 * through the refresh token, and a longer cookie would silently change how long an idle OIDC session
 * survives. Local mode never sets an issuer (the installer refuses one — infra/start.sh), so the issuer
 * is a reliable mode signal at config time.
 */
const LOCAL_SESSION_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
const OIDC_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Whether the session cookie carries the `Secure` flag / `__Secure-` prefix (ADR-0086 §6, security).
 *
 * Auth.js defaults this to `NODE_ENV === "production"`. That default is WRONG for a self-hosted
 * prod-over-HTTP deploy (local/LAN): the build is production, so Auth.js would emit a `Secure` cookie
 * the browser silently drops over plain HTTP — a silent login failure with no error. We instead key it
 * to the ACTUAL origin scheme (`AUTH_URL` → `NEXTAUTH_URL` → `WEB_ORIGIN`): `https` → Secure, `http` →
 * not. `HttpOnly` + `SameSite=Lax` stay on always (Auth.js's own defaults for the session cookie —
 * untouched here). For an existing HTTPS deploy `AUTH_URL` is `https://…`, so this returns `true` —
 * byte-identical to today. When NO origin is pinned the deploy is host-agnostic plain-HTTP LAN mode
 * (#1035 / ADR-0087) reached over http, so the tail returns `false` (never Secure) rather than the
 * stock `NODE_ENV` default, which would wrongly emit a Secure cookie a browser drops over http.
 */
function deriveUseSecureCookies(): boolean {
  // `||` (not `??`): compose pins `AUTH_URL: ${WEB_ORIGIN:-}`, so in host-agnostic LAN mode the var is
  // present but EMPTY (`""`). `??` would treat that empty string as "set" and stop; `||` falls through
  // to the next candidate, and to the no-origin tail when none is pinned.
  const origin =
    process.env.AUTH_URL || process.env.NEXTAUTH_URL || process.env.WEB_ORIGIN;
  if (origin) {
    try {
      return new URL(origin).protocol === "https:";
    } catch {
      // Malformed origin → fall through to the no-origin tail rather than guess.
    }
  }
  // No pinned origin ⇒ host-agnostic plain-HTTP LAN mode (ADR-0087), reached over http on any Host
  // behind Caddy on :80 ⇒ NEVER Secure (a Secure cookie is silently dropped over http → silent login
  // failure). Every non-LAN container path pins an origin (local/real/oidc all set WEB_ORIGIN), so
  // this tail only fires for LAN. Keying it to the ACTUAL origin scheme keeps https origins Secure.
  return false;
}

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
 * caller can end the session (expired) or retry on the next read (#1307). Never throws.
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

/**
 * Generic OIDC provider. Auth.js runs discovery from `issuer`
 * (`{issuer}/.well-known/openid-configuration`) — no Zitadel-specific code.
 * BYOI: replace these three env vars to swap IdPs.
 *
 * When AUTH_INTERNAL_ISSUER is set, the custom fetch (above) rewrites server-side OIDC
 * request URLs from the external issuer origin to the internal Docker origin. We rely on
 * discovery + that rewriting fetch alone: oauth4webapi's discovery is driven by `issuer`,
 * so wellKnown / token / userinfo overrides would be ignored and only add confusion.
 *
 * Only registered when `externalIssuer` (`AUTH_ISSUER`) is set (issue #1008 / ADR-0086). In
 * `AUTH_MODE=local` that env is unset, so `issuer` would be `undefined` and Auth.js fails to
 * initialize this provider — every Auth.js route (starting with `GET /api/auth/csrf`) then 500s
 * with "There was a problem with the server configuration", breaking the session for local
 * deploys entirely. Dropping the provider outright when there is no issuer leaves Credentials as
 * the sole provider in local mode, so the handler initializes cleanly; an OIDC deploy (issuer
 * set) is unaffected.
 */
const oidcProvider = {
  id: "oidc",
  name: "Your organization",
  type: "oidc" as const,
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
  // `prompt=login` forces the IdP to re-authenticate rather than reuse an existing browser
  // session, so Zitadel skips its shared account-picker (issue #952: a brand-new employee was
  // shown OTHER people's accounts on a machine that had prior sessions). The per-user `ui_locales`
  // param is passed dynamically at sign-in time from the /login page (the active next-intl locale).
  authorization: { params: { scope: "openid profile email offline_access", prompt: "login" } },
  // Map the OIDC standard claims to the Auth.js user. Fall back to
  // `preferred_username` / a `given_name + family_name` join when an IdP omits
  // the composite `name` claim, so the topbar never falls back to "—".
  profile(profile: { name?: string; given_name?: string; family_name?: string; preferred_username?: string; email?: string; sub: string }) {
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
};

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    /**
     * First-party local credentials provider (ADR-0086 §6, `AUTH_MODE=local`). Always registered —
     * it lives ALONGSIDE the OIDC provider — OIDC instances never invoke it (the /login screen only
     * calls `signIn("credentials")` when `authMode === "local"`), so the OIDC flow is byte-identical.
     * `authorize` delegates the actual credential check to the API's `POST /auth/login` (argon2id,
     * rate-limit, uniform 401 — the browser never sees a password hash) and returns the API-minted
     * session token on the user; the `jwt` callback moves it onto `token.accessToken`, so the entire
     * downstream (Bearer forwarding, the proxy gate, the global-401 handler) is unchanged.
     */
    Credentials({
      id: "credentials",
      name: "Local account",
      credentials: {
        identifier: { label: "Email or username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(rawCredentials) {
        // Validate against the SHARED login contract before touching the network (never trust the form).
        const parsed = LoginRequestSchema.safeParse(rawCredentials);
        if (!parsed.success) return null;
        try {
          const result = await apiFetch<LoginResponse>("/auth/login", {
            method: "POST",
            body: parsed.data,
          });
          const name =
            [result.user.firstName, result.user.lastName]
              .filter(Boolean)
              .join(" ")
              .trim() ||
            result.user.username ||
            result.user.email;
          return {
            id: result.user.id,
            name,
            email: result.user.email,
            // Carried onto the JWT in the `jwt` callback (a Credentials sign-in has no `account.access_token`).
            accessToken: result.token,
            expiresAt: result.expiresAt,
          };
        } catch {
          // Any failure (incl. the API's uniform 401) → null → Auth.js reports a generic CredentialsSignin
          // error. No user enumeration: the backend already returns one indistinguishable 401 for every case.
          return null;
        }
      },
    }),
    // Only registered when an OIDC issuer is configured — see `oidcProvider`'s doc comment
    // (issue #1008): an unconfigured OIDC provider 500s the whole Auth.js handler in local mode.
    ...(externalIssuer ? [oidcProvider] : []),
  ],

  // Host-agnostic LAN mode (#1035): with `AUTH_URL` unset, Auth.js falls back to trusting the request
  // `Host` — but it only does so when `trustHost` is TRUE. The `AUTH_TRUST_HOST=true` env alone does NOT
  // enable it in this custom-config setup (Auth.js throws `UntrustedHost` on the internal
  // /api/auth/session call otherwise), so we must set it explicitly here. Gated on the env so dev/local/
  // real (where `AUTH_URL` is pinned) are byte-identical. Safe only because Caddy is the single ingress
  // that sets `Host`; never expose the web container directly.
  ...(process.env.AUTH_TRUST_HOST === "true" ? { trustHost: true } : {}),

  // `Secure` keyed to the real origin scheme, not `NODE_ENV` (ADR-0086 §6) — see deriveUseSecureCookies.
  useSecureCookies: deriveUseSecureCookies(),

  session: {
    /** Stateless JWT session — no session DB required (ADR-0039). */
    strategy: "jwt",
    // Cookie lifetime by mode (#1307) — see LOCAL_SESSION_MAX_AGE_SECONDS.
    maxAge: externalIssuer
      ? OIDC_SESSION_MAX_AGE_SECONDS
      : LOCAL_SESSION_MAX_AGE_SECONDS,
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
     * - The token cannot be renewed — no refresh_token (a local session, or an IdP that didn't grant
     *   offline_access) or the refresh failed — and it HAS expired: return `null`, which makes Auth.js
     *   drop the cookie and report "no session" to `proxy.ts`, the (app) layout and `/login` alike, so
     *   the visitor is redirected to sign in before any page renders (#1307). Inside the skew window
     *   the still-valid token is kept (a failed refresh is retried on the next read).
     * - No `expiresAt` (remember-me, an IdP without expiry, a pre-#1307 cookie): never ended by time
     *   here. If the API rejects the token anyway, the global-401 handler (issue #657) signs out.
     */
    async jwt({ token, account, user, trigger, session }) {
      // `user` is only present on the initial sign-in; persist identity on the token.
      if (user) {
        token.name = user.name ?? token.name;
        token.email = user.email ?? token.email;
      }

      // Client-driven session update (`useSession().update({ accessToken })`) — used by the local-mode
      // change-password flow (ADR-0086 §F4b): the API minted a FRESH session token at the new
      // `sessionEpoch` (the change revoked the old one), so persist it into the cookie here or a reload
      // would re-seed the dead token. Guarded to a well-typed string; nothing else about the token
      // changes, so the OIDC refresh cycle below is untouched.
      if (trigger === "update") {
        const payload = session as
          | { accessToken?: unknown; expiresAt?: unknown }
          | undefined;
        const next = payload?.accessToken;
        if (typeof next === "string" && next.length > 0) {
          token.accessToken = next;
          // The re-minted token's expiry (#1307): a number, or `null` for a remember-me session with no
          // time-based expiry. Anything else leaves the recorded expiry as it was.
          const nextExpiresAt = payload?.expiresAt;
          if (nextExpiresAt === null) {
            token.expiresAt = undefined;
          } else if (
            typeof nextExpiresAt === "number" &&
            Number.isFinite(nextExpiresAt)
          ) {
            token.expiresAt = nextExpiresAt;
          }
        }
        return token;
      }

      // Initial sign-in: snapshot the tokens from the provider's response.
      if (account) {
        // Local (Credentials) sign-in (ADR-0086 §6): there is no IdP token exchange — the API already
        // minted the session token and `authorize` returned it on `user`. There is no refresh cycle for a
        // local session (no `refreshToken`): the token's `expiresAt` is recorded so the session ends once
        // it passes (#1307, ADR-0086 §8); a "keep me signed in" token (`null`) records none and is ended
        // only by revocation (the API's `sessionEpoch` re-check).
        if (account.type === "credentials") {
          token.accessToken = user?.accessToken ?? token.accessToken;
          token.expiresAt =
            typeof user?.expiresAt === "number" ? user.expiresAt : undefined;
          token.refreshToken = undefined;
          delete token.error;
          return token;
        }
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

      // No expiry recorded → nothing to time; the session is not ended by time (remember-me, an IdP
      // without expiry, a pre-#1307 cookie). A dead token still 401s and #657 signs out.
      if (typeof token.expiresAt !== "number") return token;

      // Access token still valid (minus skew) → reuse it.
      if (Date.now() < (token.expiresAt - REFRESH_SKEW_SECONDS) * 1000) {
        return token;
      }

      const expired = Date.now() >= token.expiresAt * 1000;

      // Expired/near-expiry and no refresh_token → it cannot be renewed. Once it has actually expired,
      // end the session server-side (#1307) instead of carrying a dead Bearer into the app.
      if (!token.refreshToken) return expired ? null : token;

      const refreshed = await refreshAccessToken(token.refreshToken);
      if ("error" in refreshed) {
        // Expired and unrenewable → end the session (#1307). Still inside the skew window → keep the
        // valid token, mark the failure, and retry on the next read.
        if (expired) return null;
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
