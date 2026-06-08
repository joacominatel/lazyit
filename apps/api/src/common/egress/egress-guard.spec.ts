import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  assertUrlAllowed,
  createNodeTransport,
  createPinnedLookup,
  guardedFetch,
  isUrlAllowed,
} from './egress-guard';
import { EgressError, type DnsLookup, type EgressTransportResponse } from './types';

const PUBLIC_V4 = '93.184.216.34';
const publicLookup: DnsLookup = async () => [{ address: PUBLIC_V4, family: 4 }];

function lookupReturning(...addrs: Array<{ address: string; family: 4 | 6 }>): DnsLookup {
  return async () => addrs;
}

describe('assertUrlAllowed — scheme allowlist (parse, never sniff)', () => {
  it.each([
    'javascript:alert(document.cookie)',
    'javascript:1/alert(document.cookie)', // the SEC-051 host:port carve-out bypass shape
    'vbscript:1/msgbox(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'file:///etc/passwd',
    'gopher://127.0.0.1:6379/_INFO',
    'dict://127.0.0.1:11211/',
    'ftp://example.com/x',
    'ldap://10.0.0.1/',
  ])('rejects the non-http(s) scheme %j', async (url) => {
    await expect(assertUrlAllowed(url)).rejects.toMatchObject({ reason: 'scheme-not-allowed' });
  });

  it('accepts a public https url', async () => {
    const target = await assertUrlAllowed('https://example.com/path', { lookup: publicLookup });
    expect(target.address).toBe(PUBLIC_V4);
    expect(target.port).toBe(443);
    expect(target.category).toBe('global');
  });

  it('defaults to HTTPS only — rejects an http url unless http is opted in (SEC-A4)', async () => {
    // Secure-by-default: no implicit cleartext downgrade.
    await expect(
      assertUrlAllowed('http://example.com/', { lookup: publicLookup }),
    ).rejects.toMatchObject({ reason: 'scheme-not-allowed' });
  });

  it('accepts a public http url (and defaults the port to 80) ONLY when http is opted in', async () => {
    const target = await assertUrlAllowed('http://example.com/', {
      allowedProtocols: ['http:'],
      lookup: publicLookup,
    });
    expect(target.port).toBe(80);
  });

  it('honours a custom allowedProtocols list', async () => {
    await expect(
      assertUrlAllowed('http://example.com/', { allowedProtocols: ['https:'], lookup: publicLookup }),
    ).rejects.toMatchObject({ reason: 'scheme-not-allowed' });
  });

  it('rejects a non-absolute / malformed url', async () => {
    await expect(assertUrlAllowed('/relative/path')).rejects.toMatchObject({ reason: 'invalid-url' });
    await expect(assertUrlAllowed('http://')).rejects.toMatchObject({ reason: 'invalid-url' });
  });

  it('rejects an http(s) url with an empty authority as invalid', async () => {
    // For special schemes the WHATWG parser rejects an empty authority outright.
    await expect(assertUrlAllowed('http://')).rejects.toMatchObject({ reason: 'invalid-url' });
  });

  it('rejects a (custom-allowed) scheme whose authority is empty (empty-host guard)', async () => {
    // A non-special scheme can parse with an empty hostname; the empty-host guard is the backstop.
    await expect(
      assertUrlAllowed('foo://', { allowedProtocols: ['foo:'] }),
    ).rejects.toMatchObject({ reason: 'empty-host' });
  });
});

describe('assertUrlAllowed — IP-literal blocked ranges (no DNS)', () => {
  // https URLs: the new default is HTTPS-only (SEC-A4); the scheme is irrelevant to address blocking.
  const blocked: Array<[string, string]> = [
    ['https://127.0.0.1/', 'loopback'],
    ['https://127.0.0.1:6379/', 'loopback'],
    ['https://0.0.0.0/', 'unspecified'],
    ['https://[::1]/', 'loopback'],
    ['https://[::ffff:127.0.0.1]/', 'loopback'],
    ['https://169.254.169.254/latest/meta-data/', 'imds'],
    ['https://10.0.0.5/', 'private'],
    ['https://172.16.0.1/', 'private'],
    ['https://192.168.1.1/', 'private'],
    ['https://[fc00::1]/', 'uniqueLocal'],
    ['https://[fe80::1]/', 'linkLocal'],
    ['https://[fd00:ec2::254]/', 'imds'],
  ];

  it.each(blocked)('blocks %s as %s', async (url, category) => {
    await expect(assertUrlAllowed(url)).rejects.toMatchObject({ reason: 'blocked-address', category });
  });
});

describe('assertUrlAllowed — obfuscated IP encodings (normalized by URL parser, then blocked)', () => {
  const blocked: Array<[string, string]> = [
    ['https://2130706433/', 'loopback'], // decimal 127.0.0.1
    ['https://0x7f000001/', 'loopback'], // hex 127.0.0.1
    ['https://0177.0.0.1/', 'loopback'], // octal 127.0.0.1
    ['https://0xa9fea9fe/', 'imds'], // hex 169.254.169.254
    ['https://2852039166/', 'imds'], // decimal 169.254.169.254
    ['https://0x0a000005/', 'private'], // hex 10.0.0.5
  ];

  it.each(blocked)('blocks %s as %s', async (url, category) => {
    await expect(assertUrlAllowed(url)).rejects.toMatchObject({ reason: 'blocked-address', category });
  });
});

describe('assertUrlAllowed — userinfo cannot hide the real host', () => {
  it('blocks https://decoy@127.0.0.1/ (authority host is 127.0.0.1)', async () => {
    await expect(assertUrlAllowed('https://expected.example.com@127.0.0.1/')).rejects.toMatchObject({
      reason: 'blocked-address',
      category: 'loopback',
    });
  });

  it('blocks https://user:pass@10.0.0.1/', async () => {
    await expect(assertUrlAllowed('https://user:pass@10.0.0.1/')).rejects.toMatchObject({
      reason: 'blocked-address',
      category: 'private',
    });
  });

  it('validates the real host when userinfo looks like a public host', async () => {
    // host is 169.254.169.254 (IMDS); the userinfo "example.com" is irrelevant.
    await expect(assertUrlAllowed('https://example.com@169.254.169.254/')).rejects.toMatchObject({
      reason: 'blocked-address',
      category: 'imds',
    });
  });
});

describe('assertUrlAllowed — DNS name resolving to a denied address (mock resolver)', () => {
  it('blocks a hostname that resolves to a private IP', async () => {
    await expect(
      assertUrlAllowed('https://intranet.example.com/', { lookup: lookupReturning({ address: '10.1.2.3', family: 4 }) }),
    ).rejects.toMatchObject({ reason: 'blocked-address', category: 'private' });
  });

  it('blocks a hostname that resolves to the IMDS address (DNS rebinding target)', async () => {
    await expect(
      assertUrlAllowed('https://rebind.example.com/', {
        lookup: lookupReturning({ address: '169.254.169.254', family: 4 }),
        // even WITH an allowlist that says yes, IMDS is never allowlistable:
        isInternalTargetAllowed: () => true,
      }),
    ).rejects.toMatchObject({ reason: 'blocked-address', category: 'imds' });
  });

  it('rejects the host if ANY resolved address is denied (public + private split)', async () => {
    await expect(
      assertUrlAllowed('https://split.example.com/', {
        lookup: lookupReturning({ address: PUBLIC_V4, family: 4 }, { address: '192.168.0.9', family: 4 }),
      }),
    ).rejects.toMatchObject({ reason: 'blocked-address', category: 'private' });
  });

  it('allows a hostname that resolves only to public IPs and pins the first', async () => {
    const target = await assertUrlAllowed('https://api.example.com/', {
      lookup: lookupReturning({ address: '1.1.1.1', family: 4 }, { address: '8.8.8.8', family: 4 }),
    });
    expect(target.address).toBe('1.1.1.1');
    expect(target.addresses).toHaveLength(2);
  });

  it('maps a resolver throw to dns-resolution-failed', async () => {
    await expect(
      assertUrlAllowed('https://nope.example.com/', {
        lookup: async () => {
          throw new Error('ENOTFOUND');
        },
      }),
    ).rejects.toMatchObject({ reason: 'dns-resolution-failed' });
  });

  it('maps an empty resolver result to dns-resolution-failed', async () => {
    await expect(
      assertUrlAllowed('https://empty.example.com/', { lookup: async () => [] }),
    ).rejects.toMatchObject({ reason: 'dns-resolution-failed' });
  });
});

describe('assertUrlAllowed — internal-target allowlist SEAM', () => {
  it('allows a private IP only when the seam returns true', async () => {
    const target = await assertUrlAllowed('https://10.0.0.5:8080/', { isInternalTargetAllowed: () => true });
    expect(target.address).toBe('10.0.0.5');
    expect(target.category).toBe('private');
  });

  it('blocks a private IP when the seam returns false', async () => {
    await expect(
      assertUrlAllowed('https://10.0.0.5/', { isInternalTargetAllowed: () => false }),
    ).rejects.toMatchObject({ reason: 'blocked-address', category: 'private' });
  });

  it('supports an async seam', async () => {
    const target = await assertUrlAllowed('https://[fc00::1]/', { isInternalTargetAllowed: async () => true });
    expect(target.category).toBe('uniqueLocal');
  });

  it('passes the resolved context to the seam', async () => {
    const seam = jest.fn().mockReturnValue(true);
    await assertUrlAllowed('https://10.0.0.5:8443/x', { isInternalTargetAllowed: seam });
    expect(seam).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: '10.0.0.5', port: 8443, address: '10.0.0.5', family: 4, category: 'private' }),
    );
  });

  it('NEVER routes loopback through the seam (loopback is not allowlistable)', async () => {
    const seam = jest.fn().mockReturnValue(true);
    await expect(
      assertUrlAllowed('https://127.0.0.1/', { isInternalTargetAllowed: seam }),
    ).rejects.toMatchObject({ reason: 'blocked-address', category: 'loopback' });
    expect(seam).not.toHaveBeenCalled();
  });

  it('NEVER routes IMDS through the seam (imds is not allowlistable)', async () => {
    const seam = jest.fn().mockReturnValue(true);
    await expect(
      assertUrlAllowed('https://169.254.169.254/', { isInternalTargetAllowed: seam }),
    ).rejects.toMatchObject({ reason: 'blocked-address', category: 'imds' });
    expect(seam).not.toHaveBeenCalled();
  });
});

describe('isUrlAllowed', () => {
  it('returns false for a blocked url and true for an allowed one', async () => {
    expect(await isUrlAllowed('https://127.0.0.1/')).toBe(false);
    expect(await isUrlAllowed('https://example.com/', { lookup: publicLookup })).toBe(true);
  });
});

describe('createPinnedLookup', () => {
  it('returns the pinned address regardless of the hostname (single-callback form)', () => {
    const lookup = createPinnedLookup('203.0.113.5', 4);
    const cb = jest.fn();
    lookup('rebind.attacker.test', {}, cb);
    expect(cb).toHaveBeenCalledWith(null, '203.0.113.5', 4);
  });

  it('returns the array form when options.all is set', () => {
    const lookup = createPinnedLookup('203.0.113.5', 4);
    const cb = jest.fn();
    lookup('x', { all: true }, cb);
    expect(cb).toHaveBeenCalledWith(null, [{ address: '203.0.113.5', family: 4 }]);
  });

  it('supports the (hostname, callback) overload', () => {
    const lookup = createPinnedLookup('203.0.113.5', 4) as unknown as (h: string, cb: unknown) => void;
    const cb = jest.fn();
    lookup('x', cb);
    expect(cb).toHaveBeenCalledWith(null, '203.0.113.5', 4);
  });
});

// ---- guardedFetch orchestration with an injected fake transport ----

function fakeResponse(status: number, headers: Record<string, string> = {}, body = ''): EgressTransportResponse {
  const h = new Headers(headers);
  return {
    status,
    statusText: '',
    headers: h,
    toResponse: () => new Response(body, { status, headers: h }),
    discard: jest.fn(),
  };
}

function queueTransport(responses: EgressTransportResponse[]) {
  const calls: Array<{ url: string; req: Parameters<import('./types').EgressTransport>[1] }> = [];
  const transport: import('./types').EgressTransport = async (url, req) => {
    calls.push({ url: url.href, req });
    const r = responses[calls.length - 1];
    if (!r) {
      throw new Error(`unexpected transport call #${calls.length}`);
    }
    return r;
  };
  return { transport, calls };
}

describe('guardedFetch — redirect re-validation', () => {
  it('does NOT auto-follow a redirect to an internal target (re-validates each hop)', async () => {
    const { transport, calls } = queueTransport([fakeResponse(302, { location: 'https://169.254.169.254/' })]);
    await expect(
      guardedFetch('https://allowed.test/', {}, { transport, lookup: publicLookup }),
    ).rejects.toMatchObject({ reason: 'blocked-address', category: 'imds' });
    // The first hop was dialed; the blocked redirect target was NEVER dialed.
    expect(calls).toHaveLength(1);
  });

  it('follows a redirect to another allowed host and returns the final response', async () => {
    const { transport, calls } = queueTransport([
      fakeResponse(302, { location: 'https://allowed2.test/next' }),
      fakeResponse(200, {}, 'ok'),
    ]);
    const res = await guardedFetch('https://allowed.test/', {}, { transport, lookup: publicLookup });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(calls.map((c) => c.url)).toEqual(['https://allowed.test/', 'https://allowed2.test/next']);
  });

  it('enforces the redirect cap', async () => {
    const { transport } = queueTransport([
      fakeResponse(302, { location: '/a' }),
      fakeResponse(302, { location: '/b' }),
    ]);
    await expect(
      guardedFetch('https://allowed.test/', {}, { transport, lookup: publicLookup, maxRedirects: 1 }),
    ).rejects.toMatchObject({ reason: 'too-many-redirects' });
  });

  it('rejects a redirect without a Location header', async () => {
    const { transport } = queueTransport([fakeResponse(302, {})]);
    await expect(
      guardedFetch('https://allowed.test/', {}, { transport, lookup: publicLookup }),
    ).rejects.toMatchObject({ reason: 'redirect-missing-location' });
  });

  it('drops ALL credential/custom headers (not just Authorization/Cookie) on a cross-origin redirect (SEC-A1)', async () => {
    const { transport, calls } = queueTransport([
      fakeResponse(301, { location: 'https://other.test/' }),
      fakeResponse(200, {}, 'ok'),
    ]);
    await guardedFetch(
      'https://allowed.test/',
      {
        headers: {
          authorization: 'Bearer secret',
          cookie: 'sid=1',
          // The admin-named custom credential headers the REST HEADER scheme / WEBHOOK_OUT signature use:
          'x-api-key': 'super-secret-key',
          'x-lazyit-signature': 'sha256=deadbeef',
          'x-keep': 'yes',
          accept: 'application/json',
        },
      },
      { transport, lookup: publicLookup },
    );
    // Every request-supplied credential/custom header is gone across the origin change…
    expect(calls[1].req.headers.authorization).toBeUndefined();
    expect(calls[1].req.headers.cookie).toBeUndefined();
    expect(calls[1].req.headers['x-api-key']).toBeUndefined();
    expect(calls[1].req.headers['x-lazyit-signature']).toBeUndefined();
    // …including a previously-surviving arbitrary header (the x-keep assertion FLIPS to dropped)…
    expect(calls[1].req.headers['x-keep']).toBeUndefined();
    // …but the small non-credential safelist survives.
    expect(calls[1].req.headers.accept).toBe('application/json');
  });

  it('drops the request body AND credential headers on a cross-origin 307/308 (no signed-body replay) (SEC-A1)', async () => {
    const { transport, calls } = queueTransport([
      fakeResponse(308, { location: 'https://other.test/' }),
      fakeResponse(200, {}, 'ok'),
    ]);
    await guardedFetch(
      'https://allowed.test/submit',
      {
        method: 'POST',
        body: '{"pii":"ada@example.com"}',
        headers: {
          'content-type': 'application/json',
          'x-lazyit-signature': 'sha256=deadbeef',
        },
      },
      { transport, lookup: publicLookup },
    );
    // 308 preserves method, but the (possibly signed, PII) body must NOT cross the origin.
    expect(calls[1].req.method).toBe('POST');
    expect(calls[1].req.body).toBeNull();
    expect(calls[1].req.headers['content-type']).toBeUndefined();
    expect(calls[1].req.headers['x-lazyit-signature']).toBeUndefined();
  });

  it('KEEPS credential headers and the body on a SAME-origin 307 redirect (SEC-A1 negative case)', async () => {
    const { transport, calls } = queueTransport([
      fakeResponse(307, { location: '/v2/submit' }), // same origin (relative)
      fakeResponse(200, {}, 'ok'),
    ]);
    await guardedFetch(
      'https://allowed.test/submit',
      {
        method: 'POST',
        body: '{"pii":"ada@example.com"}',
        headers: {
          authorization: 'Bearer secret',
          'x-api-key': 'super-secret-key',
          'content-type': 'application/json',
        },
      },
      { transport, lookup: publicLookup },
    );
    expect(calls[1].url).toBe('https://allowed.test/v2/submit');
    expect(calls[1].req.method).toBe('POST');
    expect(calls[1].req.body).toBe('{"pii":"ada@example.com"}');
    expect(calls[1].req.headers.authorization).toBe('Bearer secret');
    expect(calls[1].req.headers['x-api-key']).toBe('super-secret-key');
    expect(calls[1].req.headers['content-type']).toBe('application/json');
  });

  it('downgrades to GET and drops the body on a 303', async () => {
    const { transport, calls } = queueTransport([
      fakeResponse(303, { location: '/result' }),
      fakeResponse(200, {}, 'ok'),
    ]);
    await guardedFetch(
      'https://allowed.test/submit',
      { method: 'POST', body: 'payload', headers: { 'content-type': 'application/json' } },
      { transport, lookup: publicLookup },
    );
    expect(calls[0].req.method).toBe('POST');
    expect(calls[1].req.method).toBe('GET');
    expect(calls[1].req.body).toBeNull();
    expect(calls[1].req.headers['content-type']).toBeUndefined();
  });

  it('never dials the transport for a directly-blocked url', async () => {
    const { transport, calls } = queueTransport([]);
    await expect(guardedFetch('https://127.0.0.1/', {}, { transport })).rejects.toBeInstanceOf(EgressError);
    expect(calls).toHaveLength(0);
  });

  it('blocks IMDS through the default transport without any network call', async () => {
    await expect(guardedFetch('https://169.254.169.254/')).rejects.toMatchObject({
      reason: 'blocked-address',
      category: 'imds',
    });
  });
});

// ---- default node transport against a real local server (plumbing + pinning proof) ----

describe('createNodeTransport — real socket', () => {
  let server: http.Server;
  let port: number;

  beforeAll((done) => {
    server = http.createServer((req, res) => {
      res.setHeader('x-seen-host', req.headers.host ?? '');
      res.end('hello from server');
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  it('dials the PINNED ip even for an unresolvable hostname and returns a Response', async () => {
    const transport = createNodeTransport();
    // "pinned.invalid" never resolves via DNS; the request only succeeds because the socket is pinned
    // to 127.0.0.1 — this is the DNS-rebinding defense exercised end-to-end.
    const url = new URL(`http://pinned.invalid:${port}/`);
    const res = await transport(url, { method: 'GET', headers: {}, pin: { address: '127.0.0.1', family: 4 } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-seen-host')).toBe(`pinned.invalid:${port}`);
    const webResponse = res.toResponse();
    expect(await webResponse.text()).toBe('hello from server');
  });
});

// ---- total-time deadline: a slow upstream the per-socket IDLE timeout would NOT catch (SEC-A2) ----

describe('createNodeTransport — total deadline (SEC-A2)', () => {
  let server: http.Server;
  let port: number;
  const pending = new Set<NodeJS.Timeout>();

  beforeAll((done) => {
    server = http.createServer((req, res) => {
      // Respond only after 800ms: LONGER than the deadline, SHORTER than the idle timeout — so ONLY a
      // total-time budget (never the idle timer) can abort this request.
      const t = setTimeout(() => {
        pending.delete(t);
        if (!res.destroyed) {
          try {
            res.end('late');
          } catch {
            /* client already gone */
          }
        }
      }, 800);
      pending.add(t);
      res.on('error', () => {});
      res.on('close', () => {
        clearTimeout(t);
        pending.delete(t);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      done();
    });
  });

  afterAll((done) => {
    for (const t of pending) {
      clearTimeout(t);
    }
    server.close(done);
  });

  it('aborts the whole attempt at the deadline even though the idle timeout has not fired', async () => {
    const transport = createNodeTransport();
    const url = new URL(`http://pinned.invalid:${port}/`);
    const startedAt = Date.now();
    await expect(
      transport(url, {
        method: 'GET',
        headers: {},
        pin: { address: '127.0.0.1', family: 4 },
        timeoutMs: 1000, // idle timeout — would NOT fire before the 800ms response
        deadlineMs: 120, // total budget — fires first, regardless of socket activity
      }),
    ).rejects.toMatchObject({ reason: 'deadline-exceeded' });
    // It failed FAST near the deadline — not at the 800ms response nor the 1000ms idle timeout.
    expect(Date.now() - startedAt).toBeLessThan(700);
  });
});
