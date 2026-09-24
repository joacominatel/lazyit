import {
  McpClientAllowlistEntrySchema,
  type McpClientAllowlistEntry,
} from '@lazyit/shared';

/**
 * The CURATED DEFAULT MCP client allowlist (ADR-0097 decision 13). `ai_settings` stores only an overlay
 * on it (the admin's own entries and the ids of the defaults the admin removed), so a later release can
 * correct an identifier here without undoing the admin's choices. Ids are STABLE: renaming one would
 * resurrect a default an admin removed.
 *
 * Matching is on the CIMD `client_id` URL or an exact redirect URI (loopback `http` port-agnostic),
 * NEVER on `client_name`. Every identifier below comes from the client's own source code or
 * documentation; where several clients share a loopback callback the label names them all. Where a
 * client's identifier could not be verified (Windsurf, Zed, Pi) it is deliberately NOT seeded — an admin
 * adds it, and docs/ai-assistant/mcp-and-oauth.md §12 tracks the verification.
 *
 * A loopback entry admits any local program that uses that callback path. That is inherent to native
 * OAuth clients (RFC 8252 §8.3) and why the consent screen always shows the redirect host with a
 * loopback warning.
 */
const DEFAULTS: McpClientAllowlistEntry[] = [
  {
    id: 'claude-code-cimd',
    label: 'Claude Code (client metadata document)',
    match: {
      kind: 'cimd_url',
      url: 'https://claude.ai/oauth/claude-code-client-metadata',
    },
  },
  {
    id: 'loopback-localhost-callback',
    label: 'Claude Code, OpenAI Codex (http://localhost/callback)',
    match: { kind: 'redirect_uri', pattern: 'http://localhost/callback' },
  },
  {
    id: 'loopback-127-callback',
    label: 'Claude Code, OpenAI Codex (http://127.0.0.1/callback)',
    match: { kind: 'redirect_uri', pattern: 'http://127.0.0.1/callback' },
  },
  {
    id: 'claude-ai',
    label: 'Claude (claude.ai, Claude Desktop, Cowork)',
    match: {
      kind: 'redirect_uri',
      pattern: 'https://claude.ai/api/mcp/auth_callback',
    },
  },
  {
    id: 'claude-com',
    label: 'Claude (claude.com callback)',
    match: {
      kind: 'redirect_uri',
      pattern: 'https://claude.com/api/mcp/auth_callback',
    },
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT (developer mode connectors)',
    match: {
      kind: 'redirect_uri',
      pattern: 'https://chatgpt.com/connector_platform_oauth_redirect',
    },
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    match: {
      kind: 'redirect_uri',
      pattern: 'http://127.0.0.1/mcp/oauth/callback',
    },
  },
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    match: { kind: 'redirect_uri', pattern: 'http://localhost/oauth/callback' },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    match: {
      kind: 'redirect_uri',
      pattern: 'cursor://anysphere.cursor-mcp/oauth/callback',
    },
  },
  {
    id: 'vscode-web',
    label: 'VS Code / GitHub Copilot (vscode.dev)',
    match: { kind: 'redirect_uri', pattern: 'https://vscode.dev/redirect' },
  },
  {
    id: 'vscode-insiders-web',
    label: 'VS Code Insiders (insiders.vscode.dev)',
    match: {
      kind: 'redirect_uri',
      pattern: 'https://insiders.vscode.dev/redirect',
    },
  },
  {
    id: 'vscode-loopback-127',
    label: 'VS Code / GitHub Copilot (http://127.0.0.1/)',
    match: { kind: 'redirect_uri', pattern: 'http://127.0.0.1/' },
  },
  {
    id: 'vscode-loopback-localhost',
    label: 'VS Code / GitHub Copilot (http://localhost/)',
    match: { kind: 'redirect_uri', pattern: 'http://localhost/' },
  },
];

/** Parsed through the shared schema at load, so a malformed default fails the first test run. */
export const MCP_CLIENT_ALLOWLIST_DEFAULTS: readonly McpClientAllowlistEntry[] =
  Object.freeze(
    DEFAULTS.map((entry) => McpClientAllowlistEntrySchema.parse(entry)),
  );
