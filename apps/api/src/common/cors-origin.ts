/**
 * Resolve the CORS `origin` option for app.enableCors() (main.ts). One flag, two shapes:
 *
 *   - AUTH_TRUST_HOST=true  → `true`: reflect the request Origin back (LAN host-agnostic mode,
 *     issue #1035). The browser may reach the app at any Host (IP / hostname / localhost), so there
 *     is no single fixed origin to pin; WEB_ORIGIN is UNSET. credentials:true forbids "*", and the
 *     `cors` package treats `origin: true` as "echo the request's Origin header" — the only
 *     credential-safe answer when the origin is dynamic. In practice the browser calls the API
 *     same-origin through Caddy (ADR-0026), so this is a correctness/robustness guard, not the hot
 *     path. # ponytail: trusted-LAN ceiling — `true` accepts EVERY Origin; only sound because this
 *     flag gates a plain-HTTP, trusted-LAN deploy. Do NOT set AUTH_TRUST_HOST on an internet-facing
 *     server (boot-config also refuses it outside AUTH_MODE=local).
 *   - otherwise             → the fixed WEB_ORIGIN (default: the Next.js dev server) — byte-identical
 *     to the pre-flag behavior.
 *
 * Pure — kept out of main.ts (which drags the whole AppModule graph) so it unit-tests in isolation.
 */
export function resolveCorsOrigin(
  env: NodeJS.ProcessEnv = process.env,
): true | string {
  if (env.AUTH_TRUST_HOST === 'true') return true;
  return env.WEB_ORIGIN ?? 'http://localhost:3000';
}
