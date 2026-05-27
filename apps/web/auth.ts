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

declare module "next-auth" {
  interface Session {
    /** IdP access token, forwarded as `Authorization: Bearer` on API calls. */
    accessToken: string;
  }

  interface JWT {
    /**
     * IdP access token, stored in the encrypted session cookie on first sign-in
     * so it can be forwarded to the API on every request (ADR-0039).
     */
    accessToken?: string;
  }
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
      ...(internalIssuer ? { [customFetch]: forwardedFetch } : {}),
    },
  ],

  session: {
    /** Stateless JWT session — no session DB required (ADR-0039). */
    strategy: "jwt",
  },

  callbacks: {
    /**
     * Persist the IdP access token in the JWT cookie on first sign-in so it can
     * be forwarded to the API as a Bearer token on every request.
     */
    jwt({ token, account }) {
      if (account?.access_token) {
        token.accessToken = account.access_token;
      }
      return token;
    },

    /**
     * Expose the access token on the client-side session object returned by
     * `useSession()` and `auth()` so components and server code can read it.
     */
    session({ session, token }) {
      // token.accessToken is set in the jwt callback above.
      // The cast is required because the session callback's `token` type
      // does not automatically merge the augmented JWT interface in all
      // TypeScript configurations.
      const accessToken = (token as { accessToken?: string }).accessToken;
      session.accessToken = accessToken ?? "";
      return session;
    },
  },

  pages: {
    /** Custom login page — replaces Auth.js's built-in sign-in page. */
    signIn: "/login",
  },
});
