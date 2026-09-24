import type { McpClientAllowlistEntry } from '@lazyit/shared';
import { MCP_CLIENT_ALLOWLIST_DEFAULTS } from './client-allowlist.defaults';
import {
  type ClientTrustPolicy,
  isClientAllowed,
  isRedirectAdmitted,
  isRegistrableRedirectUri,
  matchesRegisteredRedirect,
  redirectHost,
} from './client-policy';

const defaults: ClientTrustPolicy = {
  allowlist: MCP_CLIENT_ALLOWLIST_DEFAULTS,
  allowAnyHttpsClient: false,
};
const dcr = (...redirectUris: string[]) => ({
  kind: 'dcr',
  clientId: 'lzc_x',
  redirectUris,
});

describe('client trust policy — the MCP client allowlist (ADR-0097 decision 13)', () => {
  it('ships defaults that parse and have unique ids', () => {
    const ids = MCP_CLIENT_ALLOWLIST_DEFAULTS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining(['claude-code-cimd', 'claude-ai', 'cursor']),
    );
  });

  describe('redirect-URI pattern hit', () => {
    it("admits Claude Code's loopback callback on any port", () => {
      expect(
        isClientAllowed(dcr('http://localhost:53682/callback'), defaults),
      ).toBe(true);
      expect(
        isClientAllowed(dcr('http://127.0.0.1:9/callback'), defaults),
      ).toBe(true);
    });

    it('admits the hosted Claude callback and a vetted editor scheme listed by default', () => {
      expect(
        isClientAllowed(
          dcr('https://claude.ai/api/mcp/auth_callback'),
          defaults,
        ),
      ).toBe(true);
      expect(
        isClientAllowed(
          dcr('cursor://anysphere.cursor-mcp/oauth/callback'),
          defaults,
        ),
      ).toBe(true);
    });
  });

  describe('CIMD URL hit', () => {
    it("admits a CIMD client whose client_id is Claude Code's metadata URL", () => {
      const client = {
        kind: 'cimd',
        clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
        redirectUris: [
          'http://localhost/callback',
          'http://127.0.0.1/callback',
        ],
      };
      expect(isClientAllowed(client, defaults)).toBe(true);
    });

    it('never grants the CIMD trust to a DCR client that merely claims the same id', () => {
      const spoof = {
        kind: 'dcr',
        clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
        redirectUris: ['https://attacker.example/cb'],
      };
      expect(isClientAllowed(spoof, defaults)).toBe(false);
    });
  });

  it('never matches on client_name: a registration named "Claude Code" with an unlisted redirect misses', () => {
    // The policy input has no name at all — only the redirect decides.
    expect(
      isClientAllowed(dcr('https://attacker.example/callback'), defaults),
    ).toBe(false);
  });

  it('requires EVERY redirect to be admitted (no smuggling an unlisted one next to a listed one)', () => {
    expect(
      isClientAllowed(
        dcr('http://localhost/callback', 'https://attacker.example/cb'),
        defaults,
      ),
    ).toBe(false);
  });

  it('refuses plain http off loopback, even with "allow any HTTPS client"', () => {
    const anyHttps = { ...defaults, allowAnyHttpsClient: true };
    expect(isRegistrableRedirectUri('http://example.com/cb')).toBe(false);
    expect(isClientAllowed(dcr('http://example.com/cb'), anyHttps)).toBe(false);
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript://%0aalert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'blob:https://x/y',
    'about:blank',
    'vbscript:msgbox',
    'mailto:a@b.c',
    'https://claude.ai/api/mcp/auth_callback#frag',
  ])('always refuses %s', (uri) => {
    const everything: ClientTrustPolicy = {
      allowlist: [
        ...MCP_CLIENT_ALLOWLIST_DEFAULTS,
        { id: 'x', label: 'x', match: { kind: 'redirect_uri', pattern: uri } },
      ] as McpClientAllowlistEntry[],
      allowAnyHttpsClient: true,
    };
    expect(isRegistrableRedirectUri(uri)).toBe(false);
    expect(isClientAllowed(dcr(uri), everything)).toBe(false);
  });

  describe('private-use schemes — only on an explicit allowlist entry', () => {
    const uri = 'com.example.agent:/oauth/callback';

    it('are refused by default', () => {
      expect(isClientAllowed(dcr(uri), defaults)).toBe(false);
    });

    it('are refused by the "any HTTPS client" toggle', () => {
      expect(
        isClientAllowed(dcr(uri), { ...defaults, allowAnyHttpsClient: true }),
      ).toBe(false);
    });

    it('are admitted once an admin adds the exact URI', () => {
      const policy: ClientTrustPolicy = {
        allowlist: [
          ...MCP_CLIENT_ALLOWLIST_DEFAULTS,
          {
            id: 'agent',
            label: 'Example agent',
            match: { kind: 'redirect_uri', pattern: uri },
          },
        ],
        allowAnyHttpsClient: false,
      };
      expect(isClientAllowed(dcr(uri), policy)).toBe(true);
    });

    it('are refused once the admin removes the default that listed them', () => {
      const withoutCursor = {
        allowlist: MCP_CLIENT_ALLOWLIST_DEFAULTS.filter(
          (e) => e.id !== 'cursor',
        ),
        allowAnyHttpsClient: true,
      };
      expect(
        isClientAllowed(
          dcr('cursor://anysphere.cursor-mcp/oauth/callback'),
          withoutCursor,
        ),
      ).toBe(false);
    });
  });

  it('the "any HTTPS client" toggle admits an unlisted https redirect but not an unlisted loopback one', () => {
    const anyHttps = { ...defaults, allowAnyHttpsClient: true };
    expect(isClientAllowed(dcr('https://agent.example.com/cb'), anyHttps)).toBe(
      true,
    );
    expect(
      isClientAllowed(dcr('http://localhost:3000/other-path'), anyHttps),
    ).toBe(false);
  });

  it('checks the individual redirect of a request against the policy', () => {
    const client = dcr('https://agent.example.com/cb');
    expect(
      isRedirectAdmitted(client, 'https://agent.example.com/cb', defaults),
    ).toBe(false);
    expect(
      isRedirectAdmitted(client, 'https://agent.example.com/cb', {
        ...defaults,
        allowAnyHttpsClient: true,
      }),
    ).toBe(true);
  });
});

describe('matchesRegisteredRedirect — exact matching', () => {
  const registered = [
    'https://claude.ai/api/mcp/auth_callback',
    'http://localhost:53682/callback',
    'cursor://anysphere.cursor-mcp/oauth/callback',
  ];

  it('matches an identical URI', () => {
    expect(
      matchesRegisteredRedirect(
        'https://claude.ai/api/mcp/auth_callback',
        registered,
      ),
    ).toBe(true);
    expect(
      matchesRegisteredRedirect(
        'cursor://anysphere.cursor-mcp/oauth/callback',
        registered,
      ),
    ).toBe(true);
  });

  it.each([
    'https://claude.ai/api/mcp/auth_callback/',
    'https://claude.ai/api/mcp/auth_callback?x=1',
    'https://CLAUDE.ai/api/mcp/auth_callback',
    'https://claude.ai/api/mcp/Auth_Callback',
    'https://claude.ai:443/api/mcp/auth_callback',
    'https://claude.ai.evil.example/api/mcp/auth_callback',
    'http://localhost:53682/callback/',
    'http://localhost:53682/callbacks',
  ])('refuses the near-miss %s', (uri) => {
    expect(matchesRegisteredRedirect(uri, registered)).toBe(false);
  });

  it('ignores only the port of a loopback http redirect (RFC 8252 §7.3)', () => {
    expect(
      matchesRegisteredRedirect('http://localhost:1/callback', registered),
    ).toBe(true);
    expect(
      matchesRegisteredRedirect('http://localhost/callback', registered),
    ).toBe(true);
    expect(
      matchesRegisteredRedirect('http://127.0.0.1:53682/callback', registered),
    ).toBe(false);
  });

  it('names the redirect host for the consent screen', () => {
    expect(redirectHost('https://claude.ai/api/mcp/auth_callback')).toBe(
      'claude.ai',
    );
    expect(redirectHost('http://localhost:53682/callback')).toBe(
      'localhost:53682',
    );
    expect(redirectHost('cursor://anysphere.cursor-mcp/oauth/callback')).toBe(
      'anysphere.cursor-mcp',
    );
    expect(redirectHost('com.example.agent:/cb')).toBe('com.example.agent');
  });
});
