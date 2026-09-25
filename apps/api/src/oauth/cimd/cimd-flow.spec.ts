/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- test wiring over an untyped in-memory fake and a scripted transport */
// The generated client never loads under Jest (no DB); the services run over FakeOAuthPrisma instead.
jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import type { EgressTransport } from '../../common/egress';
import {
  CLAUDE_CODE_REDIRECT,
  RESOURCE,
  buildHarness,
  connect,
  enableMcp,
  human,
  pkcePair,
  seedUser,
  useHttpsInstance,
  type Harness,
} from '../../../test/oauth/oauth-harness';
import { OAuthSweeper } from '../oauth.sweeper';
import {
  CIMD_BUNDLED_RETRY_MS,
  CIMD_CACHE_MAX_TTL_MS,
  CIMD_CACHE_MIN_TTL_MS,
  CIMD_FETCH_RATE_LIMIT,
} from './cimd.constants';
import {
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_CODE_CLIENT_METADATA,
} from './known-clients/claude-code';

/**
 * CIMD end to end over the in-memory database: an https `client_id` is resolved by fetching its metadata
 * document through the egress guard (a scripted transport stands in for the network), cached, refreshed,
 * replaced by the bundled copy when the network fails, and then run through the SAME allowlist, consent,
 * code and token path as a DCR client.
 */

const ENV_KEYS = ['WEB_ORIGIN', 'AUTH_MODE'] as const;
const savedEnv: Record<string, string | undefined> = {};
const T0 = Date.parse('2026-09-25T12:00:00Z');

const EXAMPLE_ID = 'https://tools.example.org/mcp/client.json';
const EXAMPLE_REDIRECT = 'https://tools.example.org/oauth/callback';

let h: Harness;
let served: Map<
  string,
  { status: number; body: string; headers: Record<string, string> }
>;
let fetched: string[];

/** A transport that serves `served` by URL, and fails (like an offline instance) for anything else. */
const transport: EgressTransport = async (url) => {
  fetched.push(url.href);
  const entry = served.get(url.href);
  if (!entry) throw new Error('ENETUNREACH');
  return {
    status: entry.status,
    statusText: '',
    headers: new Headers(entry.headers),
    toResponse: () =>
      new Response(entry.body, {
        status: entry.status,
        headers: entry.headers,
      }),
    discard: () => undefined,
  };
};

function serve(
  url: string,
  document: unknown,
  headers: Record<string, string> = {},
  status = 200,
): void {
  served.set(url, {
    status,
    body: JSON.stringify(document),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function exampleDocument(overrides: Record<string, unknown> = {}) {
  return {
    client_id: EXAMPLE_ID,
    client_name: 'Example Tools',
    redirect_uris: [EXAMPLE_REDIRECT],
    token_endpoint_auth_method: 'none',
    ...overrides,
  };
}

function params(clientId: string, overrides: Record<string, unknown> = {}) {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLAUDE_CODE_REDIRECT,
    code_challenge: pkcePair().challenge,
    code_challenge_method: 'S256',
    state: 'st-1',
    scope: 'lazyit.read lazyit.write',
    resource: RESOURCE,
    ...overrides,
  };
}

function audits(action: string): any[] {
  return h.prisma.tables.oAuthAuditLog.filter((row) => row.action === action);
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  jest.useFakeTimers({ now: T0, doNotFake: ['nextTick', 'setImmediate'] });
  useHttpsInstance();
  h = buildHarness();
  enableMcp(h);
  served = new Map();
  fetched = [];
  h.cimd.fetchOptions = {
    transport,
    lookup: async () => [{ address: '93.184.215.14', family: 4 }],
  };
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  jest.useRealTimers();
});

describe('resolving a CIMD client', () => {
  it('fetches, validates and caches the document as a cimd client row', async () => {
    serve(CLAUDE_CODE_CLIENT_ID, CLAUDE_CODE_CLIENT_METADATA, {
      'cache-control': 'public, max-age=3600',
    });
    const user = seedUser(h);
    const result = await h.authorization.validate(
      human(user),
      params(CLAUDE_CODE_CLIENT_ID),
      { ip: '203.0.113.9' },
    );
    expect(result).toEqual({
      ok: true,
      client: {
        id: CLAUDE_CODE_CLIENT_ID,
        name: 'Claude Code',
        uri: 'https://claude.ai/',
        verified: true,
        verifiedDomain: 'claude.ai',
      },
      redirectUri: CLAUDE_CODE_REDIRECT,
      redirectHost: 'localhost:53682',
      loopbackOnly: true,
      scopes: ['lazyit.read', 'lazyit.write'],
      user: { email: user.email },
    });
    const [row] = h.prisma.tables.oAuthClient;
    expect(row).toMatchObject({
      clientId: CLAUDE_CODE_CLIENT_ID,
      kind: 'cimd',
      name: 'Claude Code',
      redirectUris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
      fetchedAt: new Date(T0),
      metadata: {
        document: { client_id: CLAUDE_CODE_CLIENT_ID },
        cache: {
          source: 'network',
          expiresAt: new Date(T0 + 3600 * 1000).toISOString(),
        },
      },
    });
    expect(audits('CLIENT_METADATA_FETCHED')).toEqual([
      expect.objectContaining({
        userId: user.id,
        clientId: CLAUDE_CODE_CLIENT_ID,
        ip: '203.0.113.9',
        detail: expect.objectContaining({
          host: 'claude.ai',
          source: 'network',
          ttlSeconds: 3600,
          redirectHosts: ['localhost', '127.0.0.1'],
        }),
      }),
    ]);
  });

  it('serves the cache until it expires, then re-fetches (cache headers within bounds)', async () => {
    serve(CLAUDE_CODE_CLIENT_ID, CLAUDE_CODE_CLIENT_METADATA, {
      'cache-control': 'max-age=30',
    });
    const user = seedUser(h);
    await h.authorization.validate(human(user), params(CLAUDE_CODE_CLIENT_ID));
    await h.authorization.validate(human(user), params(CLAUDE_CODE_CLIENT_ID));
    // max-age=30 is clamped UP to the 5-minute floor: one fetch serves both.
    expect(fetched).toHaveLength(1);

    jest.setSystemTime(T0 + CIMD_CACHE_MIN_TTL_MS - 1000);
    await h.authorization.validate(human(user), params(CLAUDE_CODE_CLIENT_ID));
    expect(fetched).toHaveLength(1);

    jest.setSystemTime(T0 + CIMD_CACHE_MIN_TTL_MS + 1000);
    await h.authorization.validate(human(user), params(CLAUDE_CODE_CLIENT_ID));
    expect(fetched).toHaveLength(2);
    expect(h.prisma.tables.oAuthClient).toHaveLength(1);
    expect(h.prisma.tables.oAuthClient[0].fetchedAt).toEqual(
      new Date(T0 + CIMD_CACHE_MIN_TTL_MS + 1000),
    );
  });

  it('never caches longer than the 24 h ceiling', async () => {
    serve(CLAUDE_CODE_CLIENT_ID, CLAUDE_CODE_CLIENT_METADATA, {
      'cache-control': 'max-age=31536000',
    });
    const user = seedUser(h);
    await h.authorization.validate(human(user), params(CLAUDE_CODE_CLIENT_ID));
    jest.setSystemTime(T0 + CIMD_CACHE_MAX_TTL_MS + 1000);
    await h.authorization.validate(human(user), params(CLAUDE_CODE_CLIENT_ID));
    expect(fetched).toHaveLength(2);
  });

  it('picks up a changed document on re-fetch and audits the redirect change', async () => {
    serve(EXAMPLE_ID, exampleDocument());
    enableMcp(h, { mcpAllowAnyHttpsClient: true });
    const user = seedUser(h);
    await h.authorization.validate(
      human(user),
      params(EXAMPLE_ID, { redirect_uri: EXAMPLE_REDIRECT }),
    );
    const moved = 'https://tools.example.org/oauth/v2/callback';
    serve(EXAMPLE_ID, exampleDocument({ redirect_uris: [moved] }));
    jest.setSystemTime(T0 + 2 * 60 * 60 * 1000);
    // The old redirect is no longer registered…
    await expect(
      h.authorization.validate(
        human(user),
        params(EXAMPLE_ID, { redirect_uri: EXAMPLE_REDIRECT }),
      ),
    ).resolves.toEqual({ ok: false, refusal: 'INVALID_REDIRECT' });
    // …the new one is.
    await expect(
      h.authorization.validate(
        human(user),
        params(EXAMPLE_ID, { redirect_uri: moved }),
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(audits('CLIENT_METADATA_FETCHED')[1].detail).toMatchObject({
      redirectsChanged: true,
    });
  });

  it('refuses (INVALID_CLIENT, never a redirect) a document whose client_id does not match, and caches nothing', async () => {
    serve(
      EXAMPLE_ID,
      exampleDocument({ client_id: 'https://tools.example.org/other.json' }),
    );
    enableMcp(h, { mcpAllowAnyHttpsClient: true });
    const user = seedUser(h);
    await expect(
      h.authorization.validate(
        human(user),
        params(EXAMPLE_ID, { redirect_uri: EXAMPLE_REDIRECT }),
      ),
    ).resolves.toEqual({ ok: false, refusal: 'INVALID_CLIENT' });
    expect(h.prisma.tables.oAuthClient).toHaveLength(0);
    expect(audits('CLIENT_METADATA_REFUSED')).toEqual([
      expect.objectContaining({
        clientId: EXAMPLE_ID,
        userId: user.id,
        detail: { host: 'tools.example.org', reason: 'client_id_mismatch' },
      }),
    ]);
    // Not cached as an error either: the next request fetches again.
    await h.authorization.validate(
      human(user),
      params(EXAMPLE_ID, { redirect_uri: EXAMPLE_REDIRECT }),
    );
    expect(fetched).toHaveLength(2);
  });

  it('refuses a redirect_uri the document does not register (exact match, loopback port only)', async () => {
    serve(CLAUDE_CODE_CLIENT_ID, CLAUDE_CODE_CLIENT_METADATA);
    const user = seedUser(h);
    for (const redirect of [
      'http://localhost:53682/other',
      'http://localhost:53682/callback/',
      'https://claude.ai/api/mcp/auth_callback',
    ]) {
      await expect(
        h.authorization.validate(
          human(user),
          params(CLAUDE_CODE_CLIENT_ID, { redirect_uri: redirect }),
        ),
      ).resolves.toEqual({ ok: false, refusal: 'INVALID_REDIRECT' });
    }
    await expect(
      h.authorization.validate(
        human(user),
        params(CLAUDE_CODE_CLIENT_ID, {
          redirect_uri: 'http://127.0.0.1:61000/callback',
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
  });

  it('refuses an oversize document', async () => {
    served.set(EXAMPLE_ID, {
      status: 200,
      body: JSON.stringify(exampleDocument({ client_name: 'x'.repeat(6000) })),
      headers: { 'content-type': 'application/json' },
    });
    enableMcp(h, { mcpAllowAnyHttpsClient: true });
    const user = seedUser(h);
    await expect(
      h.authorization.validate(
        human(user),
        params(EXAMPLE_ID, { redirect_uri: EXAMPLE_REDIRECT }),
      ),
    ).resolves.toEqual({ ok: false, refusal: 'INVALID_CLIENT' });
    expect(audits('CLIENT_METADATA_REFUSED')[0].detail.reason).toBe(
      'too_large',
    );
  });

  it.each([
    ['loopback', '127.0.0.1'],
    ['cloud metadata', '169.254.169.254'],
    ['a private network', '10.1.2.3'],
  ])(
    'refuses a client_id host resolving to %s, without connecting (SSRF)',
    async (_label, address) => {
      h.cimd.fetchOptions = {
        transport,
        lookup: async () => [{ address, family: 4 }],
      };
      serve(EXAMPLE_ID, exampleDocument());
      enableMcp(h, { mcpAllowAnyHttpsClient: true });
      const user = seedUser(h);
      await expect(
        h.authorization.validate(
          human(user),
          params(EXAMPLE_ID, { redirect_uri: EXAMPLE_REDIRECT }),
        ),
      ).resolves.toEqual({ ok: false, refusal: 'INVALID_CLIENT' });
      expect(fetched).toHaveLength(0);
      expect(audits('CLIENT_METADATA_REFUSED')[0].detail.reason).toBe(
        'fetch_failed',
      );
    },
  );

  it.each([
    'http://tools.example.org/mcp/client.json',
    'https://tools.example.org/',
    'https://TOOLS.example.org/mcp/client.json',
    'https://u:p@tools.example.org/mcp/client.json',
  ])(
    'refuses an unacceptable client_id URL without fetching: %s',
    async (id) => {
      const user = seedUser(h);
      await expect(
        h.authorization.validate(human(user), params(id)),
      ).resolves.toEqual({ ok: false, refusal: 'INVALID_CLIENT' });
      expect(fetched).toHaveLength(0);
    },
  );

  it('fetches nothing for a user without ai:connect or while MCP is off', async () => {
    serve(CLAUDE_CODE_CLIENT_ID, CLAUDE_CODE_CLIENT_METADATA);
    const viewer = seedUser(h, { role: 'VIEWER' });
    await expect(
      h.authorization.validate(human(viewer), params(CLAUDE_CODE_CLIENT_ID)),
    ).resolves.toEqual({ ok: false, refusal: 'FORBIDDEN' });
    enableMcp(h, { mcpEnabled: false });
    const member = seedUser(h);
    await expect(
      h.authorization.validate(human(member), params(CLAUDE_CODE_CLIENT_ID)),
    ).resolves.toEqual({ ok: false, refusal: 'AI_DISABLED' });
    expect(fetched).toHaveLength(0);
  });

  it('rate-limits network fetches per user', async () => {
    enableMcp(h, { mcpAllowAnyHttpsClient: true });
    const user = seedUser(h);
    for (let i = 0; i < CIMD_FETCH_RATE_LIMIT.max; i += 1) {
      await h.authorization.validate(
        human(user),
        params(`https://tools.example.org/c/${i}`),
      );
    }
    expect(fetched).toHaveLength(CIMD_FETCH_RATE_LIMIT.max);
    await expect(
      h.authorization.validate(
        human(user),
        params('https://tools.example.org/c/one-more'),
      ),
    ).resolves.toEqual({ ok: false, refusal: 'INVALID_CLIENT' });
    expect(fetched).toHaveLength(CIMD_FETCH_RATE_LIMIT.max);
    // Another user is not affected.
    await h.authorization.validate(
      human(seedUser(h)),
      params('https://tools.example.org/c/other-user'),
    );
    expect(fetched).toHaveLength(CIMD_FETCH_RATE_LIMIT.max + 1);
  });
});

describe('the bundled offline copy', () => {
  it('stands in for Claude Code when the fetch fails, and is retried shortly after', async () => {
    // Nothing served: the transport fails like an instance without internet access.
    const user = seedUser(h);
    await expect(
      h.authorization.validate(human(user), params(CLAUDE_CODE_CLIENT_ID)),
    ).resolves.toMatchObject({
      ok: true,
      client: {
        name: 'Claude Code',
        verified: true,
        verifiedDomain: 'claude.ai',
      },
    });
    expect(h.prisma.tables.oAuthClient[0]).toMatchObject({
      kind: 'known',
      fetchedAt: null,
      metadata: {
        cache: {
          source: 'bundled',
          expiresAt: new Date(T0 + CIMD_BUNDLED_RETRY_MS).toISOString(),
        },
      },
    });
    expect(audits('CLIENT_METADATA_FETCHED')[0].detail).toMatchObject({
      source: 'bundled',
      fetchFailure: 'fetch_failed',
    });

    // Within the retry interval the bundled row is served without another attempt…
    await h.authorization.validate(human(user), params(CLAUDE_CODE_CLIENT_ID));
    expect(fetched).toHaveLength(1);
    // …after it, the network is tried again and wins once reachable.
    serve(CLAUDE_CODE_CLIENT_ID, CLAUDE_CODE_CLIENT_METADATA);
    jest.setSystemTime(T0 + CIMD_BUNDLED_RETRY_MS + 1000);
    await h.authorization.validate(human(user), params(CLAUDE_CODE_CLIENT_ID));
    expect(fetched).toHaveLength(2);
    expect(h.prisma.tables.oAuthClient[0]).toMatchObject({
      kind: 'cimd',
      fetchedAt: new Date(T0 + CIMD_BUNDLED_RETRY_MS + 1000),
    });
  });

  it('is used when the network serves something invalid (e.g. a captive portal)', async () => {
    served.set(CLAUDE_CODE_CLIENT_ID, {
      status: 200,
      body: '<html>Sign in to the Wi-Fi</html>',
      headers: { 'content-type': 'text/html' },
    });
    const user = seedUser(h);
    await expect(
      h.authorization.validate(human(user), params(CLAUDE_CODE_CLIENT_ID)),
    ).resolves.toMatchObject({ ok: true });
    expect(audits('CLIENT_METADATA_FETCHED')[0].detail).toMatchObject({
      source: 'bundled',
      fetchFailure: 'content_type',
    });
  });

  it('does not exist for other clients: a failed fetch refuses, even over a stale cached row', async () => {
    serve(EXAMPLE_ID, exampleDocument());
    enableMcp(h, { mcpAllowAnyHttpsClient: true });
    const user = seedUser(h);
    await expect(
      h.authorization.validate(
        human(user),
        params(EXAMPLE_ID, { redirect_uri: EXAMPLE_REDIRECT }),
      ),
    ).resolves.toMatchObject({ ok: true });
    served.delete(EXAMPLE_ID);
    jest.setSystemTime(T0 + 2 * 60 * 60 * 1000);
    await expect(
      h.authorization.validate(
        human(user),
        params(EXAMPLE_ID, { redirect_uri: EXAMPLE_REDIRECT }),
      ),
    ).resolves.toEqual({ ok: false, refusal: 'INVALID_CLIENT' });
    expect(audits('CLIENT_METADATA_REFUSED')[0].detail).toEqual({
      host: 'tools.example.org',
      reason: 'fetch_failed',
    });
  });
});

describe('the client allowlist still applies to CIMD clients', () => {
  it('refuses an unlisted CIMD client whose https redirect the policy does not admit', async () => {
    serve(EXAMPLE_ID, exampleDocument());
    enableMcp(h, { mcpAllowAnyHttpsClient: false });
    const user = seedUser(h);
    await expect(
      h.authorization.validate(
        human(user),
        params(EXAMPLE_ID, { redirect_uri: EXAMPLE_REDIRECT }),
      ),
    ).resolves.toEqual({ ok: false, refusal: 'INVALID_CLIENT' });
  });

  it('admits it through "any HTTPS client", showing the verified domain but not the verified badge', async () => {
    serve(EXAMPLE_ID, exampleDocument({ client_name: 'Claude Code' }));
    enableMcp(h, { mcpAllowAnyHttpsClient: true });
    const user = seedUser(h);
    await expect(
      h.authorization.validate(
        human(user),
        params(EXAMPLE_ID, { redirect_uri: EXAMPLE_REDIRECT }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      client: {
        id: EXAMPLE_ID,
        name: 'Claude Code',
        verified: false,
        verifiedDomain: 'tools.example.org',
      },
      redirectHost: 'tools.example.org',
    });
  });

  it('refuses a CIMD client with a private-use redirect unless an entry lists it', async () => {
    const appRedirect = 'org.example.tools:/oauth/callback';
    serve(EXAMPLE_ID, exampleDocument({ redirect_uris: [appRedirect] }));
    enableMcp(h, { mcpAllowAnyHttpsClient: true });
    const user = seedUser(h);
    const request = params(EXAMPLE_ID, { redirect_uri: appRedirect });
    await expect(
      h.authorization.validate(human(user), request),
    ).resolves.toEqual({ ok: false, refusal: 'INVALID_CLIENT' });

    // An admin lists the CIMD URL itself: its own registrable redirects are trusted, and it is verified.
    enableMcp(h, {
      mcpAllowAnyHttpsClient: false,
      mcpClientAllowlistAdded: [
        {
          id: 'example-tools',
          label: 'Example Tools',
          match: { kind: 'cimd_url', url: EXAMPLE_ID },
        },
      ],
    });
    await expect(
      h.authorization.validate(human(user), request),
    ).resolves.toMatchObject({
      ok: true,
      client: { verified: true, verifiedDomain: 'tools.example.org' },
    });
  });

  it('drops the verified badge when the admin removes the Claude Code CIMD default', async () => {
    serve(CLAUDE_CODE_CLIENT_ID, CLAUDE_CODE_CLIENT_METADATA);
    enableMcp(h, {
      mcpClientAllowlistRemovedDefaults: ['claude-code-cimd'],
    });
    const user = seedUser(h);
    // Its loopback redirects are still listed by their own defaults, so it connects — unverified.
    await expect(
      h.authorization.validate(human(user), params(CLAUDE_CODE_CLIENT_ID)),
    ).resolves.toMatchObject({
      ok: true,
      client: { verified: false, verifiedDomain: 'claude.ai' },
    });
    enableMcp(h, {
      mcpClientAllowlistRemovedDefaults: [
        'claude-code-cimd',
        'loopback-localhost-callback',
        'loopback-127-callback',
      ],
    });
    await expect(
      h.authorization.validate(human(user), params(CLAUDE_CODE_CLIENT_ID)),
    ).resolves.toEqual({ ok: false, refusal: 'INVALID_CLIENT' });
  });
});

describe('end to end: authorize → token → /mcp with a CIMD client', () => {
  it('connects Claude Code by its client_id URL, refreshes, and is revoked by the allowlist', async () => {
    serve(CLAUDE_CODE_CLIENT_ID, CLAUDE_CODE_CLIENT_METADATA, {
      'cache-control': 'public, max-age=300',
    });
    const user = seedUser(h);
    const { clientId, tokens } = await connect(h, user, {
      clientId: CLAUDE_CODE_CLIENT_ID,
    });
    expect(clientId).toBe(CLAUDE_CODE_CLIENT_ID);
    expect(tokens).toMatchObject({
      token_type: 'Bearer',
      access_token: expect.stringMatching(/^lzit_oat_/),
      refresh_token: expect.stringMatching(/^lzit_ort_/),
    });
    const verified = await h.tokens.verifyAccessToken(tokens.access_token);
    expect(verified).toMatchObject({
      ok: true,
      grant: { clientId: CLAUDE_CODE_CLIENT_ID, clientName: 'Claude Code' },
    });
    expect(audits('GRANT_CREATED')[0]).toMatchObject({
      clientId: CLAUDE_CODE_CLIENT_ID,
    });

    // Refresh runs on the cached row — no re-fetch at the token endpoint, even after the cache lapsed.
    jest.setSystemTime(T0 + 2 * 60 * 60 * 1000);
    const refreshed = await h.tokens.refresh({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: CLAUDE_CODE_CLIENT_ID,
      resource: RESOURCE,
    });
    expect(refreshed.access_token).toMatch(/^lzit_oat_/);
    expect(fetched).toHaveLength(1);

    // Connected apps: verified client, the redirect host.
    const [app] = await h.grants.listMine(user);
    expect(app).toMatchObject({
      client: { name: 'Claude Code', verified: true },
      redirectHost: 'localhost',
    });

    // Taking it off the allowlist cuts the connection at the next refresh.
    enableMcp(h, {
      mcpClientAllowlistRemovedDefaults: [
        'claude-code-cimd',
        'loopback-localhost-callback',
        'loopback-127-callback',
      ],
    });
    await expect(
      h.tokens.refresh({
        grant_type: 'refresh_token',
        refresh_token: refreshed.refresh_token,
        client_id: CLAUDE_CODE_CLIENT_ID,
        resource: RESOURCE,
      }),
    ).rejects.toMatchObject({ error: 'unauthorized_client' });
  });

  it('works offline too, on the bundled copy', async () => {
    const user = seedUser(h);
    const { tokens } = await connect(h, user, {
      clientId: CLAUDE_CODE_CLIENT_ID,
    });
    expect(tokens.access_token).toMatch(/^lzit_oat_/);
    expect(h.prisma.tables.oAuthClient[0].kind).toBe('known');
  });
});

describe('the sweeper', () => {
  it('collects unused CIMD cache rows after 24 h and keeps the ones with a grant', async () => {
    serve(CLAUDE_CODE_CLIENT_ID, CLAUDE_CODE_CLIENT_METADATA);
    serve(EXAMPLE_ID, exampleDocument());
    enableMcp(h, { mcpAllowAnyHttpsClient: true });
    const user = seedUser(h);
    await connect(h, user, { clientId: CLAUDE_CODE_CLIENT_ID });
    await h.authorization.validate(
      human(user),
      params(EXAMPLE_ID, { redirect_uri: EXAMPLE_REDIRECT }),
    );
    expect(h.prisma.tables.oAuthClient).toHaveLength(2);

    const sweeper = new OAuthSweeper(h.prisma as any);
    const result = await sweeper.sweep(new Date(T0 + 25 * 60 * 60 * 1000));
    expect(result.clients).toBe(1);
    expect(h.prisma.tables.oAuthClient.map((row) => row.clientId)).toEqual([
      CLAUDE_CODE_CLIENT_ID,
    ]);
  });
});
