import JSZip from 'jszip';
import {
  LAZYIT_BEHAVIOR_RULES,
  LAZYIT_DOMAIN_OVERVIEW,
} from '../../ai/prompt/primer';
import { buildMcpInstructions } from '../../ai/prompt/system-prompt';
import {
  PluginRenderError,
  type PluginToolEntry,
  renderMarketplace,
  renderPluginArchive,
  renderPluginFiles,
  renderToolIndex,
} from './plugin-renderer';
import {
  SKILL_DESCRIPTION,
  SKILL_LISTING_MAX_CHARS,
  SKILL_WHEN_TO_USE,
} from './plugin-templates';

/**
 * The plugin renderer (mcp-and-oauth.md §5.5): deterministic output, the primer rendered from its one
 * source, the per-auth-mode MCP config, and the fail-closed guards — no token, no substituted or executed
 * sequence, the listing cap.
 */

const HTTPS = 'https://lazyit.example.com';
const LAN = 'http://192.168.1.20:8080';

const TOOLS: PluginToolEntry[] = [
  {
    name: 'search_assets',
    title: 'Search assets',
    description:
      'Search the asset inventory by tag, serial or name. Returns a page of matches.',
    class: 'read',
    permissions: ['asset:read'],
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  {
    name: 'grant_access',
    title: 'Grant access',
    description:
      'Grant a person access | at a level. May trigger provisioning.',
    class: 'elevated',
    permissions: ['accessGrant:grant'],
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  {
    name: 'navigate',
    title: 'Open a page',
    description: 'Open a record in the app.',
    class: 'navigate',
    permissions: [],
    channels: ['CHAT'],
  },
  {
    name: 'my_profile',
    title: 'My profile',
    description: 'The caller.',
    class: 'read',
    permissions: [],
    channels: ['CHAT', 'MCP'],
  },
];

async function unzip(buffer: Buffer): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(buffer);
  const out: Record<string, string> = {};
  for (const [path, entry] of Object.entries(zip.files)) {
    if (!entry.dir) out[path] = await entry.async('string');
  }
  return out;
}

function byPath(files: { path: string; content: string }[]) {
  return Object.fromEntries(files.map((f) => [f.path, f.content]));
}

/** Typed JSON parse for assertions (keeps `any` out of the spec). */
interface PluginJson {
  userConfig?: Record<string, { sensitive?: boolean }>;
  mcpServers?: Record<string, { url?: string }>;
  code?: string;
  [key: string]: unknown;
}
function parseJson(text: string): PluginJson {
  return JSON.parse(text) as PluginJson;
}

/** A real-looking token of any lazyit kind. */
const REAL_TOKEN = /lzit_(pat|oat|ort|sa)_[A-Za-z0-9_-]{6,}/;

describe('Claude Code plugin renderer', () => {
  describe('files', () => {
    it('renders the OAuth variant (HTTPS): header-less MCP server at <origin>/mcp, no userConfig', () => {
      const files = byPath(
        renderPluginFiles({ origin: HTTPS, auth: 'oauth', tools: TOOLS }),
      );
      expect(Object.keys(files)).toEqual([
        '.claude-plugin/plugin.json',
        '.mcp.json',
        'skills/lazyit/SKILL.md',
        'skills/lazyit/reference/domain.md',
        'skills/lazyit/reference/tools.md',
      ]);
      expect(parseJson(files['.mcp.json'])).toEqual({
        mcpServers: {
          lazyit: { type: 'http', url: 'https://lazyit.example.com/mcp' },
        },
      });
      const manifest = parseJson(files['.claude-plugin/plugin.json']);
      expect(manifest).toEqual({
        name: 'lazyit',
        displayName: 'lazyit (lazyit.example.com)',
        description: expect.any(String) as unknown,
        homepage: HTTPS,
        author: { name: 'lazyit (lazyit.example.com)' },
      });
      expect(manifest).not.toHaveProperty('version');
      expect(manifest).not.toHaveProperty('userConfig');
    });

    it('renders the lan variant with a sensitive userConfig token and a PLACEHOLDER header — never a token', () => {
      const files = byPath(
        renderPluginFiles({
          origin: LAN,
          auth: 'personal-token',
          tools: TOOLS,
        }),
      );
      expect(parseJson(files['.mcp.json'])).toEqual({
        mcpServers: {
          lazyit: {
            type: 'http',
            url: 'http://192.168.1.20:8080/mcp',
            headers: { Authorization: 'Bearer ${user_config.token}' },
          },
        },
      });
      const manifest = parseJson(files['.claude-plugin/plugin.json']);
      expect(manifest.userConfig).toEqual({
        token: expect.objectContaining({
          type: 'string',
          sensitive: true,
          required: true,
        }) as unknown,
      });
      // The placeholder is the only `${…}` anywhere, and only in .mcp.json.
      for (const [path, content] of Object.entries(files)) {
        expect(REAL_TOKEN.test(content)).toBe(false);
        if (path !== '.mcp.json') expect(content).not.toContain('${');
      }
    });

    it('renders the domain primer from its one source (buildMcpInstructions), never a copy', () => {
      const files = byPath(
        renderPluginFiles({ origin: HTTPS, auth: 'oauth', tools: null }),
      );
      const domain = files['skills/lazyit/reference/domain.md'];
      expect(domain).toBe(`${buildMcpInstructions()}\n`);
      expect(domain).toContain(LAZYIT_DOMAIN_OVERVIEW);
      expect(domain).toContain(LAZYIT_BEHAVIOR_RULES);
    });

    it('SKILL.md carries valid frontmatter within the 1,536-character listing cap and points at the references', () => {
      expect(
        SKILL_DESCRIPTION.length + SKILL_WHEN_TO_USE.length,
      ).toBeLessThanOrEqual(SKILL_LISTING_MAX_CHARS);
      const skill = byPath(
        renderPluginFiles({ origin: HTTPS, auth: 'oauth', tools: TOOLS }),
      )['skills/lazyit/SKILL.md'];
      const [, frontmatter, body] = skill.split(/^---$/m);
      expect(frontmatter).toContain('name: lazyit');
      expect(frontmatter).toContain(
        `description: ${JSON.stringify(SKILL_DESCRIPTION)}`,
      );
      expect(frontmatter).toContain(
        `when_to_use: ${JSON.stringify(SKILL_WHEN_TO_USE)}`,
      );
      expect(body).toContain('reference/domain.md');
      expect(body).toContain('reference/tools.md');
      expect(body).toContain(HTTPS);
      expect(body).toContain('OAuth');
      expect(skill.split('\n').length).toBeLessThan(500);
    });

    it('leaves the tool index out when no catalog is given (the public archive)', () => {
      const files = byPath(
        renderPluginFiles({ origin: HTTPS, auth: 'oauth', tools: null }),
      );
      expect(files).not.toHaveProperty('skills/lazyit/reference/tools.md');
      expect(files['skills/lazyit/SKILL.md']).not.toContain('tools.md');
    });

    it('refuses an origin with credentials or a non-http scheme', () => {
      expect(() =>
        renderPluginFiles({
          origin: 'https://user:pw@lazyit.example.com',
          auth: 'oauth',
          tools: null,
        }),
      ).toThrow(PluginRenderError);
      expect(() =>
        renderPluginFiles({
          origin: 'javascript:alert(1)',
          auth: 'oauth',
          tools: null,
        }),
      ).toThrow(PluginRenderError);
    });

    it('normalizes the origin (no path, no trailing slash)', () => {
      const files = byPath(
        renderPluginFiles({
          origin: 'https://LAZYIT.example.com/some/path/',
          auth: 'oauth',
          tools: null,
        }),
      );
      expect(parseJson(files['.mcp.json']).mcpServers?.lazyit?.url).toBe(
        'https://lazyit.example.com/mcp',
      );
    });
  });

  describe('fail-closed content guard', () => {
    it.each([
      ['a user_config substitution', 'Leaks ${user_config.token} here.'],
      ['a plugin-root substitution', 'Reads ${CLAUDE_PLUGIN_ROOT}.'],
      ['a skill argument placeholder', 'Uses $ARGUMENTS.'],
      ['a positional placeholder', 'Uses $1 here.'],
      ['shell injection', 'Runs !`id` on load.'],
    ])('refuses to render %s in the tool index', (_label, description) => {
      expect(() =>
        renderPluginFiles({
          origin: HTTPS,
          auth: 'personal-token',
          tools: [{ ...TOOLS[0], description }],
        }),
      ).toThrow(PluginRenderError);
    });
  });

  describe('tool index', () => {
    it('lists MCP tools only, by name, with class and permission, pipes escaped', () => {
      const index = renderToolIndex(TOOLS);
      expect(index).not.toContain('`navigate`');
      const rows = index.split('\n').filter((line) => line.startsWith('| `'));
      expect(rows).toEqual([
        '| `grant_access` | elevated | `accessGrant:grant` | Grant access: Grant a person access \\| at a level. |',
        '| `my_profile` | read | any signed-in person | My profile: The caller. |',
        '| `search_assets` | read | `asset:read` | Search assets: Search the asset inventory by tag, serial or name. |',
      ]);
    });
  });

  describe('archive', () => {
    it('is byte-identical across renders (stable SHA-256 = the update signal and ETag)', async () => {
      const input = { origin: HTTPS, auth: 'oauth' as const, tools: TOOLS };
      const a = await renderPluginArchive(input);
      const b = await renderPluginArchive(input);
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(b.sha256).toBe(a.sha256);
      expect(Buffer.compare(a.zip, b.zip)).toBe(0);
    });

    it('changes digest with the origin, the auth mode and the catalog', async () => {
      const base = await renderPluginArchive({
        origin: HTTPS,
        auth: 'oauth',
        tools: TOOLS,
      });
      const other = await Promise.all([
        renderPluginArchive({
          origin: 'https://other.example.com',
          auth: 'oauth',
          tools: TOOLS,
        }),
        renderPluginArchive({
          origin: HTTPS,
          auth: 'personal-token',
          tools: TOOLS,
        }),
        renderPluginArchive({ origin: HTTPS, auth: 'oauth', tools: null }),
      ]);
      for (const archive of other) expect(archive.sha256).not.toBe(base.sha256);
    });

    it('unzips to the plugin layout with .claude-plugin/ at the top level', async () => {
      const { zip } = await renderPluginArchive({
        origin: HTTPS,
        auth: 'oauth',
        tools: TOOLS,
      });
      const files = await unzip(zip);
      expect(Object.keys(files).sort()).toEqual([
        '.claude-plugin/plugin.json',
        '.mcp.json',
        'skills/lazyit/SKILL.md',
        'skills/lazyit/reference/domain.md',
        'skills/lazyit/reference/tools.md',
      ]);
      expect(files).toEqual(
        byPath(
          renderPluginFiles({ origin: HTTPS, auth: 'oauth', tools: TOOLS }),
        ),
      );
    });

    it('matches the snapshot (templates and wiring; the primer is pinned by its own golden)', () => {
      for (const auth of ['oauth', 'personal-token'] as const) {
        const files = byPath(
          renderPluginFiles({
            origin: auth === 'oauth' ? HTTPS : LAN,
            auth,
            tools: TOOLS,
          }),
        );
        delete files['skills/lazyit/reference/domain.md'];
        expect(files).toMatchSnapshot(auth);
      }
    });
  });

  describe('marketplace', () => {
    it('is a URL marketplace with one archive-sourced plugin pinned by digest, and no version anywhere', () => {
      const sha = 'a'.repeat(64);
      const marketplace = renderMarketplace(HTTPS, sha);
      expect(marketplace).toEqual({
        name: 'lazyit',
        owner: { name: 'lazyit (lazyit.example.com)' },
        description: expect.any(String) as unknown,
        plugins: [
          {
            name: 'lazyit',
            displayName: 'lazyit (lazyit.example.com)',
            description: expect.any(String) as unknown,
            homepage: HTTPS,
            source: {
              source: 'archive',
              url: 'https://lazyit.example.com/api/ai/claude-code/lazyit-plugin.zip',
              sha256: sha,
            },
          },
        ],
      });
      expect(JSON.stringify(marketplace)).not.toContain('version');
    });
  });
});
