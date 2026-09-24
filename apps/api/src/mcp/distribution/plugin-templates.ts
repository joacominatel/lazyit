/**
 * The in-repo templates of the Claude Code plugin this instance serves (ADR-0097 decision 10;
 * docs/ai-assistant/mcp-and-oauth.md §5.5). Everything here is code-owned, static text: no instance data,
 * no user data, no secrets. The domain primer itself is NOT here — the renderer takes it from
 * `buildMcpInstructions()` (one source, `ai/prompt/primer.ts`) and never hand-copies it.
 *
 * Rules for editing:
 *   - Bump {@link PLUGIN_TEMPLATE_VERSION} on any change, so the render key moves with the text.
 *   - Skill markdown is pre-processed by Claude Code: `${…}` is substituted (including `${user_config.*}`,
 *     which would put a sensitive value into model context), `$ARGUMENTS`/`$N` are argument placeholders and
 *     `` !`…` `` runs a shell command when the skill loads. None of those sequences may appear in a template
 *     or in anything rendered next to it; the renderer refuses to build an archive that contains one.
 */

/** Part of the render key: the template text's own version. */
export const PLUGIN_TEMPLATE_VERSION = 1;

/** The plugin, marketplace and skill identifier (`claude plugin install lazyit@lazyit`, `/lazyit:lazyit`). */
export const PLUGIN_NAME = 'lazyit';

/** The MCP server's key in `.mcp.json` — its tools surface in Claude Code as `mcp__…lazyit__<tool>`. */
export const MCP_SERVER_NAME = 'lazyit';

/** The `userConfig` key a `lan` plugin declares for the personal MCP token. */
export const PERSONAL_TOKEN_CONFIG_KEY = 'token';

export const PLUGIN_DESCRIPTION =
  "Connects Claude Code to this lazyit instance over MCP and teaches it lazyit's domain: assets, assignments, application access, consumables and the knowledge base.";

/** SKILL.md `description` + `when_to_use` share a 1,536-character listing cap (Claude Code skills docs). */
export const SKILL_LISTING_MAX_CHARS = 1_536;

export const SKILL_DESCRIPTION =
  "Work with this organization's lazyit instance, the IT team's system of record: the asset inventory (laptops, servers, network gear, licenses) and who holds each asset, application access grants and access requests, consumable stock, the knowledge base, locations and the infrastructure map. Uses the lazyit MCP tools.";

export const SKILL_WHEN_TO_USE =
  'When the user asks about an IT asset, device, serial number or asset tag; who has which asset; onboarding or offboarding a person; granting, revoking or requesting access to an application; toner, cables or other consumable stock; an IT procedure or knowledge-base article; a location, room or rack; or a host, virtual machine or container in the infrastructure map.';

/** How the bundled MCP server authenticates, in the skill's words. */
export const SKILL_CONNECTION_TEXT = {
  oauth: `- The bundled \`${MCP_SERVER_NAME}\` MCP server signs in with OAuth. The first time a lazyit tool is needed, Claude Code opens the browser to sign in to lazyit and approve the access; \`/mcp\` shows the connection and re-authenticates it.
- The access is the person's own lazyit permissions, limited to what they approved (read only, or read and write).`,
  'personal-token': `- The bundled \`${MCP_SERVER_NAME}\` MCP server authenticates with the personal MCP token entered when the plugin was enabled. Tokens are created in lazyit under Account, AI connections, and they expire. When lazyit tools answer 401, the token expired or was revoked: ask the person to create a new one and enter it in the plugin's configuration.
- The access is the person's own lazyit permissions.`,
} as const;

/**
 * The SKILL.md body after the frontmatter. `{{origin}}`, `{{connection}}` and `{{references}}` are the
 * only placeholders; the renderer fills them.
 */
export const SKILL_BODY_TEMPLATE = `# lazyit

lazyit is the IT team's system of record for this organization, served at {{origin}}. Every read and change goes through the \`${MCP_SERVER_NAME}\` MCP server bundled with this plugin; there is no other way in, and nothing here replaces its tools.

## First, read the domain
Before the first lazyit action in a conversation, read [reference/domain.md](reference/domain.md). It explains the asset-centric model (ownership is an assignment, never a field), soft deletion, access grants and requests, consumable movements and knowledge-base visibility, and the rules for working with lazyit on this channel. Follow it.
{{references}}
## Workflow
1. Resolve before acting: search for every record the request names (an asset tag or serial, a person's email, an application's exact name, an article slug) and read it. Never invent ids or values.
2. Before a change, say exactly what will change and on which records. Make destructive, privilege, identity or access changes one at a time.
3. After the tools answer, report what actually changed, with identifiers the person recognizes. A forbidden or not-found answer is final.
4. Lists are paginated: narrow the query or page through the results instead of guessing.

## Connection
{{connection}}
- Never ask for, accept or repeat a token, password or other secret in the conversation.
`;

/** The line SKILL.md adds when the archive carries the generated tool index. */
export const SKILL_TOOL_INDEX_REFERENCE = `
[reference/tools.md](reference/tools.md) lists the lazyit tools this build ships, with their class and the permission each needs. The tools you can actually call are the ones the MCP server lists for this connection.
`;

/** Header of the generated `reference/tools.md`. */
export const TOOL_INDEX_HEADER = `# lazyit tools

Generated from this instance's live tool registry. The MCP server lists only the tools the connected person may use with the access they granted; a tool below that it does not list is outside their permissions or the granted access.

Classes: \`read\` never changes data; \`write\` changes data and your client asks for confirmation; \`elevated\` changes privileges, identity, credentials or access and needs the broadest granted access.
`;
