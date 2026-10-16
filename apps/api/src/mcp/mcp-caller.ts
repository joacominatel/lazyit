import type { AuthInfo } from '@modelcontextprotocol/server';
import type { AiToolClass, OAuthScope } from '@lazyit/shared';
import type { DelegatedIdentity } from '../auth/delegated-identity';
import type { AiExecutionContext } from '../ai/core/tool-descriptor';

/**
 * The verified caller of one `/mcp` request (mcp-and-oauth.md §5.3 "Factory per request"). Ids only —
 * the principal is re-loaded from the database by the AI core and again by `JwtAuthGuard`'s delegated
 * branch on every tool call, never carried as a loaded row.
 */
export interface McpCaller {
  /** How the caller authenticated: an OAuth access token, a personal token (`lan`), or a Service Account. */
  kind: 'oauth' | 'personal' | 'service';
  identity: DelegatedIdentity;
  /** The grant the call came through (OAuth and personal tokens); absent for a Service Account. */
  grant?: {
    id: string;
    /** `OAuthClient.clientId`; null for a personal token. */
    clientId: string | null;
    clientName: string | null;
    scopes: OAuthScope[];
  };
  /** The tool-class ceiling: the scopes (R7), or the Service Account's AI access setting. */
  ceiling: readonly AiToolClass[];
  /** The rate-limit key: the grant, or the Service Account. */
  rateKey: string;
  /**
   * Service Accounts only: the per-SA `maxMutationsPerRun` cap, applied over MCP (which has no runs) as the
   * maximum number of writes per rolling hour (CTO decision, #1315 G3 review F2). Null or absent = no cap.
   */
  maxWritesPerHour?: number | null;
}

/**
 * The scope hierarchy (R7; the MCP spec: servers MUST account for scope hierarchies). A grant stores
 * exactly the scopes the user ticked; here any scope implies `read`, `lazyit.write` adds `write` and
 * `lazyit.admin` adds `elevated`. `navigate` is never reachable over MCP. `lazyit.admin` alone does not
 * imply `write` — the ceiling never grows beyond what was granted.
 */
export function scopesToCeiling(scopes: readonly OAuthScope[]): AiToolClass[] {
  if (scopes.length === 0) return [];
  const ceiling: AiToolClass[] = ['read'];
  if (scopes.includes('lazyit.write')) ceiling.push('write');
  if (scopes.includes('lazyit.admin')) ceiling.push('elevated');
  return ceiling;
}

/** The AI core's execution context for a call from this caller. */
export function executionContextOf(
  caller: McpCaller,
  requestId?: string,
): AiExecutionContext {
  return {
    identity: caller.identity,
    channel: 'MCP',
    ceiling: caller.ceiling,
    ...(caller.grant
      ? {
          mcp: {
            grantId: caller.grant.id,
            // A personal token has no OAuth client: the ledger records its grant, and `personal` as client.
            clientId: caller.grant.clientId ?? 'personal',
          },
        }
      : {}),
    ...(requestId ? { provenance: { requestId } } : {}),
  };
}

const CALLER_KEY = 'lazyit.mcpCaller';

/**
 * The SDK's `AuthInfo` for a verified caller. `createMcpHandler` passes it through untouched to the
 * per-request factory. The bearer itself is NEVER copied here: nothing downstream needs it.
 */
export function toAuthInfo(caller: McpCaller, expiresAt?: Date): AuthInfo {
  return {
    token: '[verified]',
    clientId: caller.grant?.clientId ?? caller.rateKey,
    scopes: caller.grant?.scopes ?? [],
    ...(expiresAt ? { expiresAt: Math.floor(expiresAt.getTime() / 1000) } : {}),
    extra: { [CALLER_KEY]: caller },
  };
}

/** The caller carried by an `AuthInfo`, or null (the factory then serves nothing — fail closed). */
export function callerOf(authInfo: AuthInfo | undefined): McpCaller | null {
  const value = authInfo?.extra?.[CALLER_KEY];
  if (!value || typeof value !== 'object') return null;
  return value as McpCaller;
}
