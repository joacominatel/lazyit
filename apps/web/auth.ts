/**
 * Auth.js v5 (next-auth@beta) configuration — ADR-0039.
 *
 * A single generic OIDC provider driven entirely by three environment variables:
 *   AUTH_ISSUER        — OIDC discovery base URL (e.g. https://auth.example.com)
 *   AUTH_CLIENT_ID     — OIDC client ID
 *   AUTH_CLIENT_SECRET — OIDC client secret
 *
 * The IdP is Zitadel by default (ADR-0037), but any OIDC-compliant provider works
 * with no code changes — BYOI by env vars.
 *
 * Session strategy: JWT (no DB session). The IdP's access token is stored in the
 * encrypted session cookie so the frontend can attach it as Bearer on API calls.
 * See ADR-0039 for the full rationale.
 */

import NextAuth from "next-auth";

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

export const { handlers, auth, signIn, signOut } = NextAuth({
  /**
   * Generic OIDC provider. Auth.js infers the discovery document from `issuer`
   * (`{issuer}/.well-known/openid-configuration`) — no Zitadel-specific code.
   * BYOI: replace these three env vars to swap IdPs.
   */
  providers: [
    {
      id: "oidc",
      name: "Your organization",
      type: "oidc",
      issuer: process.env.AUTH_ISSUER,
      clientId: process.env.AUTH_CLIENT_ID,
      clientSecret: process.env.AUTH_CLIENT_SECRET,
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
