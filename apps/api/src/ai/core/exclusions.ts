import { ServiceAccountsController } from '../../service-accounts/service-accounts.controller';
import { UsersController } from '../../users/users.controller';
import { bind, type HandlerRef } from './tool-descriptor';

/**
 * The STRUCTURAL catalog exclusions (ADR-0097 decision 11, INV-AI-14; synthesis §4.1). Boot validation
 * refuses any tool that binds one of these, on every channel, whatever a toolset file declares — so a
 * later tool cannot expose them by accident.
 *
 * Excluded by route prefix (a whole surface, including endpoints added to it later):
 *   - the Secret Manager and service secret fetch — zero-knowledge (ADR-0061, INV-10);
 *   - workflow secrets — the value would enter model context (INV-AI-5);
 *   - `/auth/*` — credentials: login answers a session token, password change and reset;
 *   - the AI's own configuration and surfaces — `/config/ai*` (provider, key, budgets, retention, per-SA AI
 *     access), `/ai/*`, the OAuth authorization server (`/oauth/*`, incl. personal tokens, which answer a
 *     credential), `/mcp` and the OAuth metadata under `/.well-known`.
 */
export const EXCLUDED_ROUTE_PREFIXES: readonly string[] = [
  'secret-manager',
  'secret-vaults',
  'secret-fetch',
  'workflow-secrets',
  'auth',
  'config/ai',
  'ai',
  'oauth',
  'mcp',
  '.well-known',
];

/**
 * Excluded handler by handler: operations that answer a credential in CLEARTEXT, on otherwise ordinary
 * surfaces.
 */
export const EXCLUDED_HANDLERS: readonly HandlerRef[] = [
  // Service Account token create / rotate answer the token once.
  bind(ServiceAccountsController, 'create'),
  bind(ServiceAccountsController, 'rotate'),
  // A one-time temporary password (local mode) and the admin reset, which may answer one.
  bind(UsersController, 'provisionLocalAccount'),
  bind(UsersController, 'resetPassword'),
];

/** Whether a normalized route path falls under an excluded prefix (segment-aware). */
export function isExcludedPath(path: string): boolean {
  return EXCLUDED_ROUTE_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/** Whether a handler is excluded one by one. */
export function isExcludedHandler(ref: HandlerRef): boolean {
  return EXCLUDED_HANDLERS.some(
    (excluded) =>
      excluded.controller === ref.controller && excluded.method === ref.method,
  );
}
