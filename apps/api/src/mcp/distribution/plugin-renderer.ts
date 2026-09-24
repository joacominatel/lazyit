import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import type { AiChannel, AiToolClass, AiMcpAuthMode } from '@lazyit/shared';
import { AI_PROMPT_VERSION } from '../../ai/ai.constants';
import { buildMcpInstructions } from '../../ai/prompt/system-prompt';
import {
  MCP_SERVER_NAME,
  PERSONAL_TOKEN_CONFIG_KEY,
  PLUGIN_DESCRIPTION,
  PLUGIN_NAME,
  PLUGIN_TEMPLATE_VERSION,
  SKILL_BODY_TEMPLATE,
  SKILL_CONNECTION_TEXT,
  SKILL_DESCRIPTION,
  SKILL_LISTING_MAX_CHARS,
  SKILL_TOOL_INDEX_REFERENCE,
  SKILL_WHEN_TO_USE,
  TOOL_INDEX_HEADER,
} from './plugin-templates';

/**
 * The Claude Code plugin renderer (ADR-0097 decision 10; mcp-and-oauth.md §5.5). PURE and DETERMINISTIC:
 * the same input gives byte-identical files and archive (fixed entry order, fixed timestamps, no clock, no
 * randomness, no I/O), so the archive's SHA-256 is a stable update signal for Claude Code's `archive`
 * source and a stable ETag.
 *
 * Its inputs are only the public origin, the MCP auth mode, and (optionally) the code-owned tool
 * catalog. It never receives a token, a setting, a user or a request: nothing else can reach the output.
 */

/** The part of a registered tool the index renders — code-owned metadata only. */
export interface PluginToolEntry {
  name: string;
  title: string;
  description: string;
  class: AiToolClass;
  permissions: readonly string[];
  channels: readonly AiChannel[];
}

export interface PluginRenderInput {
  /** The instance's public origin, `scheme://host[:port]` — no path. */
  origin: string;
  /** `oauth` on a pinned HTTPS origin; `personal-token` on `lan` (`resolveMcpAuthMode`). */
  auth: AiMcpAuthMode;
  /**
   * The tool catalog for `reference/tools.md`, or `null` to leave the index out (the public archive —
   * see mcp-and-oauth.md §5.5, "What is public").
   */
  tools: readonly PluginToolEntry[] | null;
}

export interface PluginFile {
  path: string;
  content: string;
}

export interface RenderedPluginArchive {
  zip: Buffer;
  /** Lower-case hex SHA-256 of `zip`. */
  sha256: string;
}

/** Every archive entry gets this timestamp — the DOS epoch — so the bytes do not depend on the clock. */
const FIXED_ENTRY_DATE = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

/**
 * Sequences Claude Code pre-processes in plugin files (plugins-reference: `${…}` substitution, including
 * sensitive `${user_config.*}` values, in skill markdown and MCP configs; skills: `$ARGUMENTS`/`$N`
 * placeholders, and shell injection in both forms: inline `` !`…` `` and a fenced block opened with
 * ```` ```! ````). None may appear in a skill file; in `.mcp.json` only the
 * one header placeholder the renderer writes itself is allowed.
 */
const PREPROCESSED_SEQUENCE = /\$\{|\$ARGUMENTS|\$\d|!`|^\s*`{3,}!/m;

export class PluginRenderError extends Error {}

/** Normalize and validate an origin: `http(s)://host[:port]`, nothing else. */
export function normalizeOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new PluginRenderError(`unsupported origin scheme: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new PluginRenderError('origin must not carry credentials');
  }
  return url.origin;
}

/** The public MCP endpoint for an origin. */
export function mcpUrl(origin: string): string {
  return `${origin}/mcp`;
}

/** The public archive URL (`/api` is stripped by Caddy; the API route is `/ai/claude-code/…`). */
export function publicArchiveUrl(origin: string): string {
  return `${origin}/api/ai/claude-code/lazyit-plugin.zip`;
}

function displayName(origin: string): string {
  return `lazyit (${new URL(origin).host})`;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** One line of the tool index: the first sentence of the description, capped. */
function oneLiner(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  return sentence.length > 200 ? `${sentence.slice(0, 197)}...` : sentence;
}

/** A table cell: one line, pipes escaped. */
function cell(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\|/g, '\\|');
}

/** `reference/tools.md`, from the registry: MCP-listed tools only, ordered by name. */
export function renderToolIndex(tools: readonly PluginToolEntry[]): string {
  const rows = tools
    .filter((tool) => tool.channels.includes('MCP'))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => {
      const permission =
        tool.permissions.length > 0
          ? tool.permissions.map((p) => `\`${p}\``).join(' + ')
          : 'any signed-in person';
      return `| \`${tool.name}\` | ${tool.class} | ${permission} | ${cell(tool.title)}: ${cell(oneLiner(tool.description))} |`;
    });
  return `${TOOL_INDEX_HEADER}
| Tool | Class | Permission | What it does |
| --- | --- | --- | --- |
${rows.join('\n')}
`;
}

function renderSkill(input: PluginRenderInput, origin: string): string {
  const listing = SKILL_DESCRIPTION.length + SKILL_WHEN_TO_USE.length;
  if (listing > SKILL_LISTING_MAX_CHARS) {
    throw new PluginRenderError(
      `SKILL.md description + when_to_use is ${listing} characters (max ${SKILL_LISTING_MAX_CHARS})`,
    );
  }
  // JSON strings are valid YAML double-quoted scalars: no quoting surprises from colons or quotes.
  const frontmatter = [
    '---',
    `name: ${PLUGIN_NAME}`,
    `description: ${JSON.stringify(SKILL_DESCRIPTION)}`,
    `when_to_use: ${JSON.stringify(SKILL_WHEN_TO_USE)}`,
    '---',
  ].join('\n');
  const body = SKILL_BODY_TEMPLATE.replace('{{origin}}', origin)
    .replace('{{references}}', input.tools ? SKILL_TOOL_INDEX_REFERENCE : '')
    .replace('{{connection}}', SKILL_CONNECTION_TEXT[input.auth]);
  return `${frontmatter}\n\n${body}`;
}

function renderManifest(
  input: PluginRenderInput,
  origin: string,
): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    name: PLUGIN_NAME,
    displayName: displayName(origin),
    description: PLUGIN_DESCRIPTION,
    homepage: origin,
    author: { name: displayName(origin) },
  };
  if (input.auth === 'personal-token') {
    manifest.userConfig = {
      [PERSONAL_TOKEN_CONFIG_KEY]: {
        type: 'string',
        title: 'lazyit personal MCP token',
        description:
          'A personal MCP token (lzit_pat_…) from lazyit: Account, AI connections. It expires; create a new one when it does.',
        sensitive: true,
        required: true,
      },
    };
  }
  // No `version`: the archive's SHA-256 is the update signal, and no build version is disclosed.
  return manifest;
}

function renderMcpConfig(
  input: PluginRenderInput,
  origin: string,
): Record<string, unknown> {
  const server: Record<string, unknown> = {
    type: 'http',
    url: mcpUrl(origin),
  };
  if (input.auth === 'personal-token') {
    // A PLACEHOLDER Claude Code substitutes from the user's secure storage — never a real token.
    server.headers = {
      Authorization: `Bearer \${user_config.${PERSONAL_TOKEN_CONFIG_KEY}}`,
    };
  }
  // OAuth needs no block: Claude Code discovers the authorization server from `/mcp`'s 401 and the
  // protected-resource metadata, and registers itself (CIMD or DCR).
  return { mcpServers: { [MCP_SERVER_NAME]: server } };
}

/** The plugin's files, in archive order. */
export function renderPluginFiles(input: PluginRenderInput): PluginFile[] {
  const origin = normalizeOrigin(input.origin);
  const files: PluginFile[] = [
    {
      path: '.claude-plugin/plugin.json',
      content: json(renderManifest(input, origin)),
    },
    { path: '.mcp.json', content: json(renderMcpConfig(input, origin)) },
    { path: 'skills/lazyit/SKILL.md', content: renderSkill(input, origin) },
    {
      path: 'skills/lazyit/reference/domain.md',
      content: `${buildMcpInstructions()}\n`,
    },
  ];
  if (input.tools) {
    files.push({
      path: 'skills/lazyit/reference/tools.md',
      content: renderToolIndex(input.tools),
    });
  }
  assertNoPreprocessedSequences(files);
  return files;
}

/** Fail closed: no file may carry a sequence Claude Code would substitute or execute (see above). */
export function assertNoPreprocessedSequences(
  files: readonly PluginFile[],
): void {
  const allowedHeader = `\${user_config.${PERSONAL_TOKEN_CONFIG_KEY}}`;
  for (const file of files) {
    const text =
      file.path === '.mcp.json'
        ? file.content.split(allowedHeader).join('')
        : file.content;
    if (PREPROCESSED_SEQUENCE.test(text)) {
      throw new PluginRenderError(
        `${file.path} contains a sequence Claude Code would substitute or execute`,
      );
    }
  }
}

/** Zip the files deterministically (fixed order, timestamps and compression). */
export async function buildPluginArchive(
  files: readonly PluginFile[],
): Promise<RenderedPluginArchive> {
  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.path, file.content, {
      date: FIXED_ENTRY_DATE,
      createFolders: false,
    });
  }
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'UNIX',
  });
  return {
    zip: buffer,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}

/** Render and zip in one step. */
export async function renderPluginArchive(
  input: PluginRenderInput,
): Promise<RenderedPluginArchive> {
  return buildPluginArchive(renderPluginFiles(input));
}

/**
 * The marketplace name: `lazyit-<host>` in kebab-case. Claude Code keys added marketplaces by name, and a
 * second marketplace with an existing name REPLACES the first — naming it after the host lets one user add
 * several instances (staging, production) side by side.
 */
export function marketplaceName(origin: string): string {
  const slug = new URL(normalizeOrigin(origin)).host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `${PLUGIN_NAME}-${slug}` : PLUGIN_NAME;
}

/**
 * The URL marketplace (`claude plugin marketplace add <origin>/api/ai/claude-code/marketplace.json`).
 * One plugin, an `archive` source (HTTPS only in Claude Code) pinned by SHA-256 and with no `version`, so
 * the digest is the update signal.
 */
export function renderMarketplace(
  origin: string,
  archiveSha256: string,
): Record<string, unknown> {
  const normalized = normalizeOrigin(origin);
  return {
    name: marketplaceName(normalized),
    owner: { name: displayName(normalized) },
    description: PLUGIN_DESCRIPTION,
    plugins: [
      {
        name: PLUGIN_NAME,
        displayName: displayName(normalized),
        description: PLUGIN_DESCRIPTION,
        homepage: normalized,
        source: {
          source: 'archive',
          url: publicArchiveUrl(normalized),
          sha256: archiveSha256,
        },
      },
    ],
  };
}

/**
 * What a rendered archive depends on besides its per-request input: the prompt version and the
 * template version. The distribution cache keys on it so a change to either can never serve a stale
 * archive (the registry is fixed after boot, and the content hash covers the rest).
 */
export const PLUGIN_RENDER_REVISION = `p${AI_PROMPT_VERSION}.t${PLUGIN_TEMPLATE_VERSION}`;
