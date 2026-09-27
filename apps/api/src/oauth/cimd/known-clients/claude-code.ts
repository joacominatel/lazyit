/**
 * Claude Code's Client ID Metadata Document, BUNDLED in the image (mcp-and-oauth.md §4 F2, synthesis §4.8):
 * the copy lazyit falls back to when the network fetch of `client_id` fails, so an HTTPS instance without
 * internet access can still connect Claude Code. It is the verbatim document served at the URL (fetched
 * 2026-09-25, `Cache-Control: public, max-age=300`), and it is validated by the SAME parser as a fetched
 * one — a bundled copy is never trusted more than the network copy, only used when that one is unavailable.
 *
 * Kept as a TypeScript module rather than a `.json` file so it is compiled into `dist/` without a build
 * asset rule (the API tsconfig does not enable `resolveJsonModule`). Update it when Anthropic changes the
 * document; the network copy wins whenever it is reachable.
 */
export const CLAUDE_CODE_CLIENT_ID =
  'https://claude.ai/oauth/claude-code-client-metadata';

export const CLAUDE_CODE_CLIENT_METADATA = {
  client_id: 'https://claude.ai/oauth/claude-code-client-metadata',
  client_name: 'Claude Code',
  client_uri: 'https://claude.ai',
  redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
} as const;
