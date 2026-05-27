/**
 * Auth.js v5 route-protection proxy — ADR-0039.
 *
 * Named `proxy.ts` per the Next.js 16 file convention (renamed from `middleware.ts`
 * — see https://nextjs.org/docs/messages/middleware-to-proxy).
 *
 * Protects all routes under the (app) group. Unauthenticated visitors are
 * redirected to /login. The (auth) group routes (/login, /api/auth/**) remain
 * public so the sign-in flow can complete.
 *
 * The `authorized` callback is called for every matched request. Returning
 * false redirects to the configured `pages.signIn` (set to "/login" in auth.ts).
 *
 * Matcher: The Next.js config `matcher` below excludes static assets, the
 * Auth.js endpoints, the login page, and Next.js internals from the proxy
 * entirely, keeping overhead minimal.
 */
import { auth } from "@/auth";

export default auth((req) => {
  const { nextUrl, auth: session } = req;

  // /api/auth/** and /login are always public — handled by matcher exclusion below,
  // but we add an explicit guard here as belt-and-suspenders.
  const isPublic =
    nextUrl.pathname.startsWith("/api/auth") ||
    nextUrl.pathname === "/login" ||
    nextUrl.pathname === "/";

  if (!isPublic && !session) {
    const loginUrl = new URL("/login", nextUrl.origin);
    // Preserve the destination so Auth.js can redirect back after sign-in.
    loginUrl.searchParams.set("callbackUrl", nextUrl.pathname);
    return Response.redirect(loginUrl);
  }
});

export const config = {
  /**
   * Run middleware on all routes except:
   * - Next.js internals (_next/*)
   * - Static files (favicon, images, fonts, etc.)
   * - Auth.js OIDC endpoints (/api/auth/*)
   * - The login page itself (/login)
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/auth|login|$).*)",
  ],
};
