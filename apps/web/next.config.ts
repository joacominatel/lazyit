import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

/**
 * Baseline security response headers for every route (#501). Defence-in-depth that does not depend
 * on the deployment hostname, so it is safe on localhost AND a real domain.
 *
 * Caddy (infra/caddy/Caddyfile) already sets X-Content-Type-Options, Referrer-Policy and
 * X-Frame-Options on the public origin and strips Server. We set the SAME values here so the app is
 * hardened even when requests don't traverse Caddy (local `next dev`/`next start`, a different proxy,
 * or any direct hit) — identical values mean a duplicated header carries one consistent value, never
 * a conflicting pair. We additionally set what Caddy does NOT: Permissions-Policy, a minimal CSP
 * (`frame-ancestors 'none'`), and we drop `x-powered-by` (poweredByHeader: false). DevOps note: the
 * X-Content-Type-Options / Referrer-Policy / X-Frame-Options overlap with the Caddyfile is intended.
 */
const SECURITY_HEADERS = [
  // Stop MIME-type sniffing.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Don't leak full URLs (paths/queries) to cross-origin destinations.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Legacy clickjacking control for older browsers (CSP `frame-ancestors` is the modern one below).
  { key: "X-Frame-Options", value: "DENY" },
  // Deny powerful browser features the app never uses.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  // Minimal CSP: forbid this app from being framed by ANY origin (modern anti-clickjacking). This is
  // the one CSP directive safe to ship today — it governs framing only and cannot break script/style
  // loading. The full content CSP (script-src/style-src) is deliberately deferred: next-themes injects
  // an inline bootstrap script (needs a nonce/hash) and mermaid/codemirror/react-syntax-highlighter
  // emit inline styles (need style-src 'unsafe-inline'). Enabling those without testing the KB
  // (mermaid) and workflow (codemirror) routes would silently break them — a broken CSP is worse than
  // none. Tracked for a dedicated, tested pass.
  //
  // SCAFFOLD (do NOT enable without route testing + a nonce for the next-themes script):
  //   default-src 'self';
  //   script-src 'self' 'nonce-<per-request>';
  //   style-src 'self' 'unsafe-inline';
  //   img-src 'self' data: blob:;
  //   font-src 'self';
  //   connect-src 'self';
  //   frame-ancestors 'none';
  //   base-uri 'self';
  //   form-action 'self';
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
];

const nextConfig: NextConfig = {
  // Self-contained server bundle for the production Docker image (infra/docker/web.Dockerfile).
  // The standalone output traces only the node_modules the app actually uses, keeping the
  // runtime image small. Authorized cross-lane DevOps edit — see ADR-0025.
  output: "standalone",

  // Don't advertise the framework (#501); removes the `x-powered-by` response header.
  poweredByHeader: false,

  // Apply the baseline security headers to every route.
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

// i18n (next-intl, cookie-mode — ADR-0051). The plugin points at the request config that
// reads the locale from the NEXT_LOCALE cookie; the default path is `./i18n/request.ts`, so
// no explicit argument is needed.
const withNextIntl = createNextIntlPlugin();

export default withNextIntl(nextConfig);
