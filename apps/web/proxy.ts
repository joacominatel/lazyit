/**
 * Auth.js v5 route-protection proxy + first-run gate — ADR-0039 / ADR-0043 Phase 3.
 *
 * Named `proxy.ts` per the Next.js 16 file convention (renamed from `middleware.ts`
 * — see https://nextjs.org/docs/messages/middleware-to-proxy).
 *
 * Two responsibilities:
 *
 * 1. Route protection. Routes under the (app) group require a session; unauthenticated visitors are
 *    redirected to /login (with a `callbackUrl`). The public surfaces — /login, /setup, /api/auth/**
 *    and the marketing root — stay reachable so the sign-in and first-run flows can complete.
 *
 * 2. First-run gate (ADR-0043). A fresh, UNCONFIGURED instance (no ADMIN exists yet) has no way for an
 *    operator to discover the /setup wizard — every other entry point dead-ends before an admin
 *    exists. So on a top-level navigation, when there is no session, we ask the API
 *    `GET /config/status`; if the instance is unconfigured and the visitor is not already on /setup,
 *    we send them to /setup. A configured instance (or any signed-in user — a session implies an
 *    ADMIN already exists) skips the check entirely, and any error talking to the API FAILS OPEN
 *    (normal flow proceeds) so a transient API blip never bricks navigation.
 *
 * The `authorized` callback is called for every matched request.
 */
import type { ConfigStatus } from "@lazyit/shared";

import { auth } from "@/auth";

/**
 * API base URL for the gate's server-side `GET /config/status`. Prefers an internal URL
 * (`INTERNAL_API_URL`, e.g. the in-cluster service name) when set, falling back to the public
 * `NEXT_PUBLIC_API_URL` used by the browser client. Mirrors lib/api/client.ts's default.
 */
const API_URL =
  process.env.INTERNAL_API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:3001";

/** Public paths the gate must never trap (the sign-in/first-run/OIDC surfaces themselves). */
function isPublicPath(pathname: string): boolean {
  return (
    // Static media served from /public (the landing demo video, OG images, fonts…) is public by
    // nature and must never be auth-gated — without this a `/landing/demo.mp4` sub-resource on a
    // public route falls through to the guard below and gets 302'd to /login (these /public files
    // are served at the root, so they don't hit the matcher's `_next/static` exclusion).
    /\.(?:mp4|webm|ogg|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|mp3)$/i.test(pathname) ||
    pathname.startsWith("/api/auth") ||
    pathname === "/login" ||
    pathname === "/setup" ||
    pathname === "/" ||
    // The reporting-agent installer (ADR-0074 §6) is a public `curl | sh` script served from
    // /public — it carries NO secret (the operator passes the SA token as a flag). The extension
    // allowlist above doesn't cover `.sh`, so allow it by exact path or it'd 302 to /login.
    pathname === "/install.sh" ||
    // The Help / Manual surface is PUBLIC, login-free product documentation (ADR-0062 §3): it
    // lives in the `(marketing)` route group, but route groups add no URL segment, so `/help`
    // would otherwise fall through to route protection and redirect to /login. Allow `/help`
    // and every sub-path. The first-run `/setup` gate still runs first (it short-circuits an
    // UNCONFIGURED instance before this check), so a fresh operator is unaffected.
    pathname === "/help" ||
    pathname.startsWith("/help/")
  );
}

/**
 * Ask the API whether the instance has been configured (any ADMIN exists). Returns `false` (treat as
 * configured → no redirect) on ANY failure so a transient API problem never blocks navigation. A
 * short abort keeps the proxy from hanging on a slow/unreachable API.
 */
async function isUnconfigured(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/config/status`, {
      // Always hit the API — first-run state can flip at any moment and must never be cached stale.
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const status = (await res.json()) as ConfigStatus;
    return status.isConfigured === false;
  } catch {
    return false;
  }
}

export default auth(async (req) => {
  const { nextUrl, auth: session } = req;
  const { pathname } = nextUrl;

  // A signed-in user implies an ADMIN already exists → the instance is configured. Skip the gate and
  // only run route protection. (Route protection itself is a no-op here since there IS a session.)
  if (!session) {
    // First-run gate. Only on top-level document navigations (not RSC/prefetch/data fetches) to avoid
    // a `GET /config/status` per sub-request — `Sec-Fetch-Mode: navigate` marks a real navigation.
    const isNavigation =
      req.headers.get("sec-fetch-mode") === "navigate" ||
      req.headers.get("accept")?.includes("text/html");

    if (isNavigation && pathname !== "/setup" && (await isUnconfigured())) {
      return Response.redirect(new URL("/setup", nextUrl.origin));
    }

    // Route protection: send unauthenticated visitors of protected routes to /login, preserving the
    // intended destination so Auth.js can return them there after sign-in.
    if (!isPublicPath(pathname)) {
      const loginUrl = new URL("/login", nextUrl.origin);
      loginUrl.searchParams.set("callbackUrl", pathname);
      return Response.redirect(loginUrl);
    }
  }
});

export const config = {
  /**
   * Run the proxy on all routes except:
   * - Next.js internals (_next/*)
   * - Static files (favicon, images, fonts, etc.)
   * - Auth.js OIDC endpoints (/api/auth/*)
   * - The first-run setup wizard (/setup) — public, pre-login (ADR-0043 Phase 3)
   *
   * NB: unlike before, the marketing root (`$`) and /login ARE matched so the first-run gate can
   * redirect a fresh operator landing on them to /setup. The `isPublicPath` guard above keeps those
   * surfaces from being trapped by route protection.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/auth|setup).*)"],
};
