/**
 * The web app's Content-Security-Policy (#1440) — defence in depth behind the Markdown sanitizer
 * (ADR-0029) and the Mermaid hardening (SEC-084). If a future bug ever lets author-controlled HTML
 * reach the DOM, this policy is what stops it from running script or phoning home (a remote `<img>`
 * tracking pixel, an exfiltrating `fetch`).
 *
 * Built per request by `proxy.ts`, because scripts are allowed by a per-request NONCE (the current
 * Next.js CSP guide): Next reads the nonce back out of the request's CSP header during server
 * rendering and stamps it on its own framework/bundle/inline scripts; the root layout forwards it to
 * next-themes' inline bootstrap script. Every page is already dynamically rendered (the root layout
 * reads the session and the locale cookie), so a nonce costs no static optimization here.
 *
 * Directive by directive (docs/06-security/content-security-policy.md is the long form):
 * - `script-src` — the nonce plus `'strict-dynamic'` (chunks loaded by a trusted script are trusted),
 *   and `'wasm-unsafe-eval'` for the Secret Manager's Argon2id (hash-wasm compiles WebAssembly; this
 *   keyword allows WebAssembly compilation only, never JS `eval`). `'unsafe-eval'` exists in dev ONLY,
 *   because React's dev build uses it to rebuild server error stacks. Never `'unsafe-inline'`.
 * - `style-src 'self' 'unsafe-inline'` — the one documented concession. Mermaid's rendered SVG carries
 *   its own `<style>` element, CodeMirror / sonner / xyflow inject `<style>` tags at runtime, and
 *   server-rendered `style="…"` attributes (Radix, charts, progress bars) cannot carry a nonce at all.
 *   A nonce here would also DISABLE `'unsafe-inline'` (CSP ignores it when a nonce is present), so it
 *   is deliberately absent. Styles cannot execute script; the residual risk is CSS-based UI redress.
 * - `img-src 'self' data: blob:` — attachments and pasted images are fetched with the Bearer token and
 *   shown as `blob:` URLs, Mermaid/icons use `data:`; NO remote hosts, so an injected remote image can
 *   never load (the SEC-084 tracking-pixel class).
 * - `connect-src` — same origin (`/api` behind Caddy, ADR-0026) plus the API's origin when the build
 *   points `NEXT_PUBLIC_API_URL` at an absolute URL (local dev: `http://localhost:3001`).
 * - `object-src 'none'`, `base-uri` and `form-action 'self'` close the classic injection side doors;
 *   `frame-ancestors 'none'` (anti-clickjacking, #501) joins the policy once it enforces.
 *
 * REPORT-ONLY FIRST. The policy ships as `Content-Security-Policy-Report-Only` ({@link CSP_ENFORCED}):
 * the browser evaluates it on every page and logs what it WOULD block, but blocks nothing. Every page
 * family was driven in Chromium with zero violations except two that could not be exercised end to end
 * in that pass — AI chat streaming with approval cards, and the OAuth consent page with a real client —
 * and a CSP that is wrong there would break them silently. Flipping {@link CSP_ENFORCED} is the whole
 * change once those are confirmed (docs/06-security/content-security-policy.md, "Enforcing").
 * Framing is NOT report-only meanwhile: `next.config.ts` keeps sending the enforced
 * `Content-Security-Policy: frame-ancestors 'none'` on every response, and a report-only policy
 * cannot carry `frame-ancestors` anyway (browsers ignore it there), so it is left out of it.
 *
 * `upgrade-insecure-requests` is deliberately NOT set: lazyit is self-hosted and some instances run on
 * plain HTTP inside a LAN; upgrading their sub-resources to https would break them.
 */

/**
 * `false` = report-only (today); `true` = enforce. See the module comment for what flipping it needs.
 * Next extracts the nonce from either header, so the nonce plumbing is identical in both modes.
 */
export const CSP_ENFORCED = false;

/** Response (and forwarded request) header that carries the policy, per {@link CSP_ENFORCED}. */
export const CSP_HEADER = CSP_ENFORCED
  ? "Content-Security-Policy"
  : "Content-Security-Policy-Report-Only";

/**
 * A fresh, unguessable nonce for one request: 16 random bytes, base64 (the CSP `nonce-source` grammar
 * is base64-value). Web Crypto only, so it runs in any proxy runtime.
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * The origin to add to `connect-src` for the browser's API base URL, or `null` when the browser talks
 * to the API on its own origin (the relative `/api` every Docker image bakes — ADR-0026). Mirrors
 * `lib/api/client.ts`: unset → `http://localhost:3001`. An unparseable value yields `null` rather than
 * a broken policy (the relative-path case, which `'self'` already covers).
 */
export function apiConnectOrigin(apiUrl: string | undefined): string | null {
  const value = apiUrl ?? "http://localhost:3001";
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export interface CspOptions {
  /** The per-request nonce from {@link generateNonce}. */
  nonce: string;
  /** `next dev` — adds `'unsafe-eval'` to script-src for React's dev tooling. */
  isDev: boolean;
  /** The browser's API base URL (`NEXT_PUBLIC_API_URL`). */
  apiUrl: string | undefined;
  /**
   * Whether the policy is delivered as the enforcing header. Adds `frame-ancestors 'none'`, which a
   * report-only policy cannot carry. Defaults to {@link CSP_ENFORCED}.
   */
  enforced?: boolean;
}

/** The policy as its ordered directives — exported so the test can pin each one. */
export function cspDirectives({
  nonce,
  isDev,
  apiUrl,
  enforced = CSP_ENFORCED,
}: CspOptions): string[] {
  const apiOrigin = apiConnectOrigin(apiUrl);
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    "'wasm-unsafe-eval'",
    ...(isDev ? ["'unsafe-eval'"] : []),
  ];
  const connectSrc = ["'self'", ...(apiOrigin ? [apiOrigin] : [])];
  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "media-src 'self'",
    `connect-src ${connectSrc.join(" ")}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-src 'none'",
    ...(enforced ? ["frame-ancestors 'none'"] : []),
  ];
}

/** The header value: every directive, `; `-separated. */
export function buildContentSecurityPolicy(options: CspOptions): string {
  return cspDirectives(options).join("; ");
}

/**
 * Turn off zod 4's JIT in the browser (#1440). On its first object parse zod probes whether it may
 * compile validators with `new Function("")`; under this policy (no `'unsafe-eval'`) the probe is
 * refused — zod catches it and falls back to its interpreter, but the refusal still lands in the
 * console as a CSP violation on every form. `jitless` skips the probe and selects the interpreter
 * up front: same results, no violation. The web app does not depend on zod directly (it arrives via
 * `@lazyit/shared`), so this sets zod's documented `z.config({ jitless: true })` through the global
 * zod itself stores that config in (`globalThis.__zod_globalConfig`, shared by every zod copy) —
 * creating it when zod has not loaded yet, merging into it when it has. Called from
 * `instrumentation-client.ts`, which Next runs before any application code or hydration.
 */
export function disableZodJit(target: object = globalThis): void {
  const holder = target as { __zod_globalConfig?: Record<string, unknown> };
  holder.__zod_globalConfig ??= {};
  holder.__zod_globalConfig.jitless = true;
}
