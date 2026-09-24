import type { AiMcpAuthMode } from "@lazyit/shared";

/**
 * Pure builders for the "connect an AI app" surface of `/account/ai` (and the install panel Settings → AI
 * embeds): the instance's MCP endpoint, the Claude Code plugin commands, and per-client configuration
 * snippets — per authentication mode (docs/ai-assistant/frontend.md §5.3, mcp-and-oauth.md §13–§14).
 *
 * Everything derives from the page's own origin (`window.location.origin`): lazyit is self-hosted and
 * domain-portable, so nothing is baked at build time (the agent-install precedent,
 * `lib/agent/install-commands.ts`).
 *
 * A snippet NEVER carries a real token. On a personal-token instance the header holds
 * {@link TOKEN_PLACEHOLDER}; the only place a minted token is ever shown is its one-time reveal.
 */

/** The MCP server name every snippet registers (the same key the Claude Code plugin's `.mcp.json` uses). */
export const MCP_SERVER_NAME = "lazyit";

/** What a personal-token snippet puts where the token goes. Never a real token. */
export const TOKEN_PLACEHOLDER = "YOUR_PERSONAL_TOKEN";

/** The VS Code input id that prompts for the token (kept out of the file VS Code saves). */
export const VSCODE_TOKEN_INPUT_ID = "lazyit-token";

/** The instance origin, normalized (`scheme://host[:port]`, no path, no trailing slash). */
export function normalizeOrigin(origin: string): string {
  return new URL(origin).origin;
}

/** `{origin}/mcp` — the MCP resource. Caddy routes this path to the API unprefixed. */
export function mcpEndpointUrl(origin: string): string {
  return `${normalizeOrigin(origin)}/mcp`;
}

/** The public Claude Code URL marketplace (served only on an HTTPS instance with MCP on). */
export function marketplaceUrl(origin: string): string {
  return `${normalizeOrigin(origin)}/api/ai/claude-code/marketplace.json`;
}

/**
 * The marketplace name — `lazyit-<host>` in kebab-case, port included. Mirrors the API's
 * `marketplaceName` (apps/api/src/mcp/distribution/plugin-renderer.ts) exactly: Claude Code keys
 * marketplaces by name, so the install command must name the one the served `marketplace.json` declares.
 */
export function marketplaceName(origin: string): string {
  const slug = new URL(normalizeOrigin(origin)).host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `${MCP_SERVER_NAME}-${slug}` : MCP_SERVER_NAME;
}

/** The two commands of the one-step Claude Code install (HTTPS + OAuth instances only). */
export function claudePluginCommands(origin: string): {
  marketplaceAdd: string;
  pluginInstall: string;
} {
  return {
    marketplaceAdd: `claude plugin marketplace add ${marketplaceUrl(origin)}`,
    pluginInstall: `claude plugin install ${MCP_SERVER_NAME}@${marketplaceName(origin)}`,
  };
}

/** Per-client configuration for connecting to the MCP server directly (without the plugin). */
export interface McpClientSnippets {
  /** The MCP endpoint URL. */
  endpoint: string;
  /** `claude mcp add …` for Claude Code. */
  claudeCode: string;
  /** Cursor's `mcp.json` (`~/.cursor/mcp.json` or `.cursor/mcp.json`). */
  cursor: string;
  /** VS Code's `.vscode/mcp.json`. */
  vscode: string;
  /** The header a generic client sends, or null when the client signs in with OAuth. */
  authorizationHeader: string | null;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * The per-client snippets for one authentication mode.
 *
 * - `oauth`: only the URL. The client meets a 401, discovers the authorization server and opens the
 *   lazyit consent page in the browser.
 * - `personal-token`: the URL plus an `Authorization: Bearer` header holding {@link TOKEN_PLACEHOLDER}
 *   (VS Code prompts for it through a password input instead, so it is not written to the file).
 */
export function buildMcpClientSnippets(
  origin: string,
  auth: AiMcpAuthMode,
): McpClientSnippets {
  const endpoint = mcpEndpointUrl(origin);

  if (auth === "oauth") {
    return {
      endpoint,
      claudeCode: `claude mcp add --transport http ${MCP_SERVER_NAME} ${endpoint}`,
      cursor: json({ mcpServers: { [MCP_SERVER_NAME]: { url: endpoint } } }),
      vscode: json({
        servers: { [MCP_SERVER_NAME]: { type: "http", url: endpoint } },
      }),
      authorizationHeader: null,
    };
  }

  const header = `Authorization: Bearer ${TOKEN_PLACEHOLDER}`;
  return {
    endpoint,
    claudeCode: `claude mcp add --transport http ${MCP_SERVER_NAME} ${endpoint} \\\n  --header "${header}"`,
    cursor: json({
      mcpServers: {
        [MCP_SERVER_NAME]: {
          url: endpoint,
          headers: { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` },
        },
      },
    }),
    vscode: json({
      inputs: [
        {
          type: "promptString",
          id: VSCODE_TOKEN_INPUT_ID,
          description: "lazyit personal token",
          password: true,
        },
      ],
      servers: {
        [MCP_SERVER_NAME]: {
          type: "http",
          url: endpoint,
          headers: {
            Authorization: `Bearer \${input:${VSCODE_TOKEN_INPUT_ID}}`,
          },
        },
      },
    }),
    authorizationHeader: header,
  };
}

/**
 * Why the page explains what it explains. The UI always says which method applies and why
 * (CEO: "La UI debería detectarlo y aclararlo en cualquier caso").
 */
export type McpModeNote =
  /** Served over plain HTTP: OAuth is off, personal tokens instead; cloud connectors cannot reach it. */
  | "plain-http"
  /** Viewed over HTTPS, but the instance is not configured with an HTTPS address, so OAuth stays off. */
  | "https-not-configured"
  /** The instance uses OAuth, but this page was opened over plain HTTP — clients must use the HTTPS address. */
  | "viewing-over-http";

/** What `/account/ai` shows, decided from `GET /ai/status` and the page's own protocol. */
export type McpConnectMode =
  /** The status could not be read (loading, an error, a 404 from an older API): show nothing to install. */
  | { kind: "unknown" }
  /** MCP is switched off, or the caller lacks `ai:connect`. Existing connections stay listed. */
  | { kind: "unavailable"; auth: AiMcpAuthMode | null }
  | { kind: "oauth"; notes: McpModeNote[] }
  | { kind: "personal-token"; notes: McpModeNote[] };

/** The slice of a TanStack query result the detection reads. */
export interface AiStatusQueryLike {
  status: "pending" | "error" | "success";
  data?: unknown;
}

function readAuth(value: unknown): AiMcpAuthMode | null {
  return value === "oauth" || value === "personal-token" ? value : null;
}

/**
 * Detect the MCP connection mode. Fails closed: only a successful status read that literally says
 * `mcp.available: true` with a known `auth` offers an install; a body this build does not recognize
 * reads as "unknown".
 *
 * `pageProtocol` is `window.location.protocol` (`"https:"` / `"http:"`); it only adds explanatory notes.
 */
export function detectMcpConnectMode(
  query: AiStatusQueryLike,
  pageProtocol: string,
): McpConnectMode {
  if (query.status !== "success") return { kind: "unknown" };
  const mcp = (
    query.data as { mcp?: { available?: unknown; auth?: unknown } } | null | undefined
  )?.mcp;
  if (!mcp) return { kind: "unknown" };
  const auth = readAuth(mcp.auth);
  if (mcp.available !== true || auth === null) {
    return { kind: "unavailable", auth };
  }

  const overHttps = pageProtocol === "https:";
  if (auth === "oauth") {
    return { kind: "oauth", notes: overHttps ? [] : ["viewing-over-http"] };
  }
  return {
    kind: "personal-token",
    notes: overHttps ? ["https-not-configured"] : ["plain-http"],
  };
}

/** Whether the snippets can be offered as copy-ready, and from which origin they are built. */
export type SnippetOrigin =
  /** The server's configured address equals the page's: copy-ready. */
  | { origin: string; check: "match" }
  /** The page was reached at another address than the one the server knows: warn, not copy-ready. */
  | { origin: string; check: "mismatch"; pageOrigin: string }
  /** The server's address could not be read: built from the page, warn, not copy-ready. */
  | { origin: string; check: "unverified" };

/**
 * Parse the address the server knows for itself (the OAuth issuer, an `https:` origin). Anything else —
 * absent, not a URL, not `https:` — is null.
 */
export function parseServerOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The origin OAuth-mode snippets are built from. An OAuth client must use the instance's configured
 * HTTPS address — the issuer the tokens are bound to — not whatever address this page happened to be
 * opened at (an internal hostname, an IP, a second DNS name). So the snippets use the server's origin,
 * and are copy-ready only when it matches the page's; otherwise the panel warns first.
 */
export function resolveSnippetOrigin(
  pageOrigin: string,
  serverOrigin: string | null,
): SnippetOrigin {
  const page = normalizeOrigin(pageOrigin);
  if (serverOrigin === null) return { origin: page, check: "unverified" };
  const server = normalizeOrigin(serverOrigin);
  return server === page
    ? { origin: server, check: "match" }
    : { origin: server, check: "mismatch", pageOrigin: page };
}
