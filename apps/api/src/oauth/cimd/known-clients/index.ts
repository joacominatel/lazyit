import {
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_CODE_CLIENT_METADATA,
} from './claude-code';

/**
 * The bundled Client ID Metadata Documents, keyed by their exact Client Identifier URL. A bundled copy is
 * used ONLY when fetching the URL fails (offline instance, DNS, timeout, a transient error); a reachable
 * network copy always wins, and a bundled copy passes the same validation as a fetched one.
 */
export const KNOWN_CLIENT_DOCUMENTS: ReadonlyMap<string, unknown> = new Map<
  string,
  unknown
>([[CLAUDE_CODE_CLIENT_ID, CLAUDE_CODE_CLIENT_METADATA]]);
