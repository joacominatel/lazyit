/* eslint-disable @typescript-eslint/require-await -- scripted egress transports and resolvers mirror the async contracts */
import {
  EgressError,
  type DnsLookup,
  type EgressTransport,
} from '../../common/egress';
import { cacheLifetimeMs } from './cache-lifetime';
import {
  CIMD_CACHE_DEFAULT_TTL_MS,
  CIMD_CACHE_MAX_TTL_MS,
  CIMD_CACHE_MIN_TTL_MS,
  CIMD_MAX_DOCUMENT_BYTES,
} from './cimd.constants';
import {
  CimdRefusal,
  parseClientMetadataDocument,
  type CimdRefusalReason,
} from './cimd-document';
import { fetchClientMetadataDocument } from './cimd-fetcher';
import {
  clientIdDomain,
  looksLikeClientIdUrl,
  parseClientIdUrl,
} from './client-id-url';
import {
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_CODE_CLIENT_METADATA,
} from './known-clients/claude-code';
import { KNOWN_CLIENT_DOCUMENTS } from './known-clients';

/**
 * CIMD building blocks (draft-ietf-oauth-client-id-metadata-document): the Client Identifier URL rules, the
 * document validation, the cache lifetime, and the guarded fetch — including its SSRF refusals.
 */

const CLIENT_ID = 'https://client.example.org/oauth/metadata.json';

function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: CLIENT_ID,
    client_name: 'Example Client',
    client_uri: 'https://client.example.org',
    redirect_uris: ['https://client.example.org/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...overrides,
  };
}

function refusalOf(fn: () => unknown): CimdRefusalReason {
  try {
    fn();
  } catch (err) {
    if (err instanceof CimdRefusal) return err.reason;
    throw err;
  }
  throw new Error('expected a CimdRefusal');
}

async function asyncRefusalOf(
  promise: Promise<unknown>,
): Promise<CimdRefusalReason> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof CimdRefusal) return err.reason;
    throw err;
  }
  throw new Error('expected a CimdRefusal');
}

describe('Client Identifier URL', () => {
  it.each([
    CLAUDE_CODE_CLIENT_ID,
    'https://client.example.org/oauth/metadata.json',
    'https://client.example.org:8443/client',
    'https://client.example.org/client?v=1',
  ])('accepts %s', (url) => {
    expect(parseClientIdUrl(url)?.href).toBe(url);
  });

  it.each([
    ['plain http', 'http://client.example.org/client'],
    ['userinfo', 'https://user:pass@client.example.org/client'],
    ['an @ in the authority', 'https://client.example.org@evil.example/client'],
    ['a fragment', 'https://client.example.org/client#x'],
    ['no path', 'https://client.example.org'],
    ['the root path', 'https://client.example.org/'],
    ['a dot segment', 'https://client.example.org/a/../client'],
    ['an encoded dot segment', 'https://client.example.org/a/%2e%2e/client'],
    ['a single-dot segment', 'https://client.example.org/./client'],
    ['an upper-case host (non-canonical)', 'https://Client.example.org/client'],
    [
      'an explicit default port (non-canonical)',
      'https://client.example.org:443/client',
    ],
    ['garbage', 'https://'],
    ['an over-long URL', `https://client.example.org/${'a'.repeat(2100)}`],
  ])('refuses %s', (_label, url) => {
    expect(parseClientIdUrl(url)).toBeNull();
  });

  it('routes only https client ids to CIMD (DCR ids are lzc_…)', () => {
    expect(looksLikeClientIdUrl(CLAUDE_CODE_CLIENT_ID)).toBe(true);
    expect(looksLikeClientIdUrl('lzc_abc')).toBe(false);
    expect(looksLikeClientIdUrl('http://client.example.org/c')).toBe(false);
  });

  it('names the verified domain: the host of the client_id URL', () => {
    expect(clientIdDomain(CLAUDE_CODE_CLIENT_ID)).toBe('claude.ai');
    expect(clientIdDomain('https://client.example.org:8443/client')).toBe(
      'client.example.org:8443',
    );
    expect(clientIdDomain('lzc_abc')).toBeNull();
  });
});

describe('Client ID Metadata Document validation', () => {
  it('accepts a public client and keeps only the fields lazyit understands', () => {
    const parsed = parseClientMetadataDocument(
      doc({
        logo_uri: 'https://client.example.org/logo.png',
        jwks_uri: 'https://client.example.org/jwks.json',
        scope: 'anything',
        application_type: 'native',
      }),
      CLIENT_ID,
    );
    expect(parsed).toEqual({
      client_id: CLIENT_ID,
      client_name: 'Example Client',
      client_uri: 'https://client.example.org/',
      redirect_uris: ['https://client.example.org/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
    });
  });

  it('requires client_id to equal the URL exactly (simple string comparison)', () => {
    expect(
      refusalOf(() =>
        parseClientMetadataDocument(
          doc({ client_id: 'https://other.example.org/oauth/metadata.json' }),
          CLIENT_ID,
        ),
      ),
    ).toBe('client_id_mismatch');
    expect(
      refusalOf(() =>
        parseClientMetadataDocument(
          doc({
            client_id: 'https://client.example.org:443/oauth/metadata.json',
          }),
          CLIENT_ID,
        ),
      ),
    ).toBe('client_id_mismatch');
    expect(
      refusalOf(() =>
        parseClientMetadataDocument(doc({ client_id: undefined }), CLIENT_ID),
      ),
    ).toBe('client_id_mismatch');
  });

  it('refuses client secrets and any auth method other than none', () => {
    expect(
      refusalOf(() =>
        parseClientMetadataDocument(
          doc({ client_secret: 's3cret' }),
          CLIENT_ID,
        ),
      ),
    ).toBe('client_secret');
    expect(
      refusalOf(() =>
        parseClientMetadataDocument(
          doc({ client_secret_expires_at: 0 }),
          CLIENT_ID,
        ),
      ),
    ).toBe('client_secret');
    for (const method of [
      'client_secret_basic',
      'client_secret_post',
      'private_key_jwt',
    ]) {
      expect(
        refusalOf(() =>
          parseClientMetadataDocument(
            doc({ token_endpoint_auth_method: method }),
            CLIENT_ID,
          ),
        ),
      ).toBe('auth_method');
    }
    // Absent reads as a public client, like DCR.
    expect(
      parseClientMetadataDocument(
        doc({ token_endpoint_auth_method: undefined }),
        CLIENT_ID,
      ).token_endpoint_auth_method,
    ).toBe('none');
  });

  it('requires registrable redirect_uris', () => {
    for (const redirectUris of [
      undefined,
      [],
      'https://client.example.org/callback',
      ['javascript:alert(1)'],
      ['http://client.example.org/callback'],
      ['https://client.example.org/callback#frag'],
      ['http://localhost:80@evil.example/callback'],
      Array.from({ length: 11 }, (_, i) => `https://client.example.org/${i}`),
    ]) {
      expect(
        refusalOf(() =>
          parseClientMetadataDocument(
            doc({ redirect_uris: redirectUris }),
            CLIENT_ID,
          ),
        ),
      ).toBe('redirect_uris');
    }
  });

  it('refuses unsupported grant and response types', () => {
    expect(
      refusalOf(() =>
        parseClientMetadataDocument(
          doc({ grant_types: ['client_credentials'] }),
          CLIENT_ID,
        ),
      ),
    ).toBe('grant_types');
    expect(
      refusalOf(() =>
        parseClientMetadataDocument(
          doc({ response_types: ['token'] }),
          CLIENT_ID,
        ),
      ),
    ).toBe('grant_types');
  });

  it('sanitizes display fields: control/bidi characters stripped, non-https client_uri dropped', () => {
    const parsed = parseClientMetadataDocument(
      doc({
        client_name: 'Claude‮ Code\u0000',
        client_uri: 'javascript:alert(1)',
      }),
      CLIENT_ID,
    );
    expect(parsed.client_name).toBe('Claude Code');
    expect(parsed.client_uri).toBeNull();
    // No usable name: the verified host stands in, never "Unnamed client".
    expect(
      parseClientMetadataDocument(doc({ client_name: undefined }), CLIENT_ID)
        .client_name,
    ).toBe('client.example.org');
  });

  it('refuses a document that is not a JSON object', () => {
    for (const raw of [null, 'text', [doc()], 42]) {
      expect(refusalOf(() => parseClientMetadataDocument(raw, CLIENT_ID))).toBe(
        'malformed',
      );
    }
  });

  it('bundles a valid copy of Claude Code’s document', () => {
    expect(KNOWN_CLIENT_DOCUMENTS.get(CLAUDE_CODE_CLIENT_ID)).toBe(
      CLAUDE_CODE_CLIENT_METADATA,
    );
    expect(
      parseClientMetadataDocument(
        CLAUDE_CODE_CLIENT_METADATA,
        CLAUDE_CODE_CLIENT_ID,
      ),
    ).toMatchObject({
      client_name: 'Claude Code',
      redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    });
  });
});

describe('cache lifetime (HTTP cache headers, within bounds)', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const lifetime = (headers: Record<string, string>) =>
    cacheLifetimeMs(new Headers(headers), now);

  it('honours max-age within [5 min, 24 h]', () => {
    expect(lifetime({ 'cache-control': 'public, max-age=3600' })).toBe(
      3600 * 1000,
    );
    expect(lifetime({ 'cache-control': 'max-age=10' })).toBe(
      CIMD_CACHE_MIN_TTL_MS,
    );
    expect(lifetime({ 'cache-control': 'max-age=31536000' })).toBe(
      CIMD_CACHE_MAX_TTL_MS,
    );
    expect(lifetime({ 'cache-control': 'max-age=600, s-maxage=1200' })).toBe(
      1200 * 1000,
    );
  });

  it('treats no-store / no-cache as the minimum, never zero', () => {
    expect(lifetime({ 'cache-control': 'no-store' })).toBe(
      CIMD_CACHE_MIN_TTL_MS,
    );
    expect(lifetime({ 'cache-control': 'no-cache, max-age=9999' })).toBe(
      CIMD_CACHE_MIN_TTL_MS,
    );
  });

  it('falls back to Expires, then to the default', () => {
    expect(
      lifetime({
        date: new Date(now).toUTCString(),
        expires: new Date(now + 2 * 60 * 60 * 1000).toUTCString(),
      }),
    ).toBe(2 * 60 * 60 * 1000);
    expect(lifetime({ expires: 'garbage' })).toBe(CIMD_CACHE_DEFAULT_TTL_MS);
    expect(lifetime({})).toBe(CIMD_CACHE_DEFAULT_TTL_MS);
    expect(lifetime({ 'cache-control': 'max-age=-1' })).toBe(
      CIMD_CACHE_DEFAULT_TTL_MS,
    );
  });
});

describe('the guarded fetch', () => {
  const PUBLIC: DnsLookup = async () => [
    { address: '93.184.215.14', family: 4 },
  ];

  function respond(
    status: number,
    body: BodyInit | null,
    headers: Record<string, string> = { 'content-type': 'application/json' },
  ): { transport: EgressTransport; calls: URL[]; requests: unknown[] } {
    const calls: URL[] = [];
    const requests: unknown[] = [];
    const transport: EgressTransport = async (url, req) => {
      calls.push(url);
      requests.push(req);
      return {
        status,
        statusText: '',
        headers: new Headers(headers),
        toResponse: () => new Response(body, { status, headers }),
        discard: () => undefined,
      };
    };
    return { transport, calls, requests };
  }

  it('fetches a JSON document with a bare GET pinned to the validated address', async () => {
    const { transport, requests } = respond(200, JSON.stringify(doc()), {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'max-age=600',
    });
    const fetched = await fetchClientMetadataDocument(new URL(CLIENT_ID), {
      transport,
      lookup: PUBLIC,
    });
    expect(fetched.body).toEqual(doc());
    expect(fetched.headers.get('cache-control')).toBe('max-age=600');
    expect(requests[0]).toMatchObject({
      method: 'GET',
      headers: { accept: 'application/json' },
      pin: { address: '93.184.215.14', family: 4 },
    });
  });

  it.each([
    ['loopback', '127.0.0.1', 4],
    ['IPv6 loopback', '::1', 6],
    ['RFC 1918', '10.0.0.5', 4],
    ['RFC 1918 (192.168)', '192.168.1.10', 4],
    ['cloud metadata (IMDS)', '169.254.169.254', 4],
    ['unique-local IPv6', 'fd00::1', 6],
    ['CGNAT', '100.64.0.1', 4],
    ['unspecified', '0.0.0.0', 4],
  ] as const)(
    'refuses a host resolving to %s without connecting (SSRF)',
    async (_label, address, family) => {
      const { transport, calls } = respond(200, JSON.stringify(doc()));
      await expect(
        asyncRefusalOf(
          fetchClientMetadataDocument(new URL(CLIENT_ID), {
            transport,
            lookup: async () => [{ address, family }],
          }),
        ),
      ).resolves.toBe('fetch_failed');
      expect(calls).toHaveLength(0);
    },
  );

  it('refuses when ANY resolved address is private (no mixed-answer bypass)', async () => {
    const { transport, calls } = respond(200, JSON.stringify(doc()));
    await expect(
      asyncRefusalOf(
        fetchClientMetadataDocument(new URL(CLIENT_ID), {
          transport,
          lookup: async () => [
            { address: '93.184.215.14', family: 4 },
            { address: '127.0.0.1', family: 4 },
          ],
        }),
      ),
    ).resolves.toBe('fetch_failed');
    expect(calls).toHaveLength(0);
  });

  it('refuses a private IP literal in the URL itself', async () => {
    const { transport, calls } = respond(200, JSON.stringify(doc()));
    await expect(
      asyncRefusalOf(
        fetchClientMetadataDocument(new URL('https://169.254.169.254/latest'), {
          transport,
        }),
      ),
    ).resolves.toBe('fetch_failed');
    expect(calls).toHaveLength(0);
  });

  it('never follows a redirect — not even to a public host', async () => {
    const { transport, calls } = respond(302, null, {
      location: 'https://elsewhere.example.org/metadata.json',
    });
    await expect(
      asyncRefusalOf(
        fetchClientMetadataDocument(new URL(CLIENT_ID), {
          transport,
          lookup: PUBLIC,
        }),
      ),
    ).resolves.toBe('http_status');
    expect(calls).toHaveLength(1);
  });

  it.each([404, 500, 204, 203])(
    'treats HTTP %s as an error',
    async (status) => {
      const { transport } = respond(
        status,
        status === 204 ? null : JSON.stringify(doc()),
      );
      await expect(
        asyncRefusalOf(
          fetchClientMetadataDocument(new URL(CLIENT_ID), {
            transport,
            lookup: PUBLIC,
          }),
        ),
      ).resolves.toBe('http_status');
    },
  );

  it('requires a JSON media type', async () => {
    for (const type of ['text/html', 'text/plain', '']) {
      const { transport } = respond(
        200,
        JSON.stringify(doc()),
        type ? { 'content-type': type } : {},
      );
      await expect(
        asyncRefusalOf(
          fetchClientMetadataDocument(new URL(CLIENT_ID), {
            transport,
            lookup: PUBLIC,
          }),
        ),
      ).resolves.toBe('content_type');
    }
    const { transport } = respond(200, JSON.stringify(doc()), {
      'content-type': 'application/oauth-client-metadata+json',
    });
    await expect(
      fetchClientMetadataDocument(new URL(CLIENT_ID), {
        transport,
        lookup: PUBLIC,
      }),
    ).resolves.toMatchObject({ body: doc() });
  });

  it('refuses an oversize document, declared or streamed', async () => {
    const big = JSON.stringify(
      doc({ client_name: 'x'.repeat(CIMD_MAX_DOCUMENT_BYTES) }),
    );
    const declared = respond(200, big, {
      'content-type': 'application/json',
      'content-length': String(big.length),
    });
    await expect(
      asyncRefusalOf(
        fetchClientMetadataDocument(new URL(CLIENT_ID), {
          transport: declared.transport,
          lookup: PUBLIC,
        }),
      ),
    ).resolves.toBe('too_large');

    // No Content-Length: the body is streamed in chunks and cut off once past the limit.
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024).fill(0x20));
        if (pulled > 1000) controller.close();
      },
    });
    const streamed = respond(200, stream);
    await expect(
      asyncRefusalOf(
        fetchClientMetadataDocument(new URL(CLIENT_ID), {
          transport: streamed.transport,
          lookup: PUBLIC,
        }),
      ),
    ).resolves.toBe('too_large');
    expect(pulled).toBeLessThan(10);
  });

  it('refuses a body that is not valid JSON', async () => {
    const { transport } = respond(200, '{"client_id":');
    await expect(
      asyncRefusalOf(
        fetchClientMetadataDocument(new URL(CLIENT_ID), {
          transport,
          lookup: PUBLIC,
        }),
      ),
    ).resolves.toBe('malformed');
  });

  it('turns a timeout or a network error into fetch_failed', async () => {
    for (const error of [
      new EgressError('deadline-exceeded', 'too slow'),
      new EgressError('request-timeout', 'idle'),
      new Error('ECONNREFUSED'),
    ]) {
      await expect(
        asyncRefusalOf(
          fetchClientMetadataDocument(new URL(CLIENT_ID), {
            transport: async () => {
              throw error;
            },
            lookup: PUBLIC,
          }),
        ),
      ).resolves.toBe('fetch_failed');
    }
    await expect(
      asyncRefusalOf(
        fetchClientMetadataDocument(new URL(CLIENT_ID), {
          lookup: async () => {
            throw new Error('ENOTFOUND');
          },
        }),
      ),
    ).resolves.toBe('fetch_failed');
  });
});
