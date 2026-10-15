import {
  classifyThrownError,
  extractCorrelationId,
  hasDotSegment,
  httpErrorClass,
  joinUrl,
  MAX_CORRELATION_BODY_BYTES,
  redactHost,
  tryRevealSecret,
} from './outbound-http';
import { CredentialUnavailableError } from './step-handler';
import { EgressError } from '../../common/egress';

/** A response whose body records whether it was cancelled (the socket released). */
function trackedResponse(headers: Record<string, string>): {
  res: Response;
  cancelled: () => boolean;
} {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(8));
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    res: new Response(stream, { status: 200, headers }),
    cancelled: () => cancelled,
  };
}

function jsonResponse(
  value: unknown,
  headers: Record<string, string> = {},
): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('joinUrl', () => {
  it('normalizes a single separating slash', () => {
    expect(joinUrl('https://api.example.com/', '/v3/users')).toBe(
      'https://api.example.com/v3/users',
    );
    expect(joinUrl('https://api.example.com', 'v3/users')).toBe(
      'https://api.example.com/v3/users',
    );
  });

  it('attaches a query-only path directly', () => {
    expect(joinUrl('https://api.example.com/', '?a=1')).toBe(
      'https://api.example.com?a=1',
    );
  });
});

describe('redactHost', () => {
  it('returns only the hostname (never the query)', () => {
    expect(redactHost('https://api.example.com/x?token=secret')).toBe(
      'api.example.com',
    );
  });
  it('returns undefined for a non-url', () => {
    expect(redactHost('not a url')).toBeUndefined();
  });
});

describe('extractCorrelationId — happy paths', () => {
  it('prefers the Location header (a created resource)', async () => {
    const res = new Response(null, {
      status: 201,
      headers: {
        location: 'https://api.example.com/v3/users/42',
        'content-type': 'application/json',
      },
    });
    expect(await extractCorrelationId(res)).toBe(
      'https://api.example.com/v3/users/42',
    );
  });

  it('reads a small JSON body and returns the first allowlisted id key', async () => {
    expect(
      await extractCorrelationId(jsonResponse({ id: 'jira-acc-123' })),
    ).toBe('jira-acc-123');
    expect(await extractCorrelationId(jsonResponse({ accountId: 99 }))).toBe(
      '99',
    );
  });

  it('returns null for a non-JSON content-type (never reads the body)', async () => {
    const res = new Response('a'.repeat(10), {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    expect(await extractCorrelationId(res)).toBeNull();
  });

  it('returns null when no allowlisted key is present', async () => {
    expect(await extractCorrelationId(jsonResponse({ nope: 'x' }))).toBeNull();
  });
});

describe('extractCorrelationId — bounded read (SEC-A2)', () => {
  it('short-circuits a too-large Content-Length WITHOUT reading the body', async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': String(MAX_CORRELATION_BODY_BYTES + 1),
      },
    });

    expect(await extractCorrelationId(res)).toBeNull();
    // The declared length already exceeds the cap → we must NOT have started reading…
    expect(pulls).toBe(0);
    // …and we release the socket by cancelling the stream.
    expect(cancelled).toBe(true);
  });

  it('aborts a streamed body the moment it exceeds the cap (never buffers it all)', async () => {
    const CHUNK = 16 * 1024; // 16 KiB
    const TOTAL_CHUNKS = 256; // would be 4 MiB if fully buffered
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > TOTAL_CHUNKS) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(CHUNK));
      },
      cancel() {
        cancelled = true;
      },
    });
    // No content-length header → the streamed byte counter is the only guard.
    const res = new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    expect(await extractCorrelationId(res)).toBeNull();
    // It aborted shortly after crossing 64 KiB — only a handful of 16 KiB chunks, NOT all 256.
    expect(pulls).toBeLessThanOrEqual(MAX_CORRELATION_BODY_BYTES / CHUNK + 2);
    expect(pulls).toBeLessThan(TOTAL_CHUNKS);
    expect(cancelled).toBe(true);
  });

  it('reads a JSON body that sits just under the cap', async () => {
    // A valid JSON object whose serialized size is < the cap is still parsed.
    const padding = 'x'.repeat(MAX_CORRELATION_BODY_BYTES - 64);
    const res = jsonResponse({ id: 'ok-under-cap', pad: padding });
    expect(await extractCorrelationId(res)).toBe('ok-under-cap');
  });
});

describe('classifyThrownError', () => {
  it('classifies an EgressError as permanent egress-blocked', () => {
    const c = classifyThrownError(new EgressError('blocked-address', 'nope'));
    expect(c).toMatchObject({ errorClass: 'egress-blocked', transient: false });
  });

  it('classifies a total-deadline EgressError as permanent (egress-blocked)', () => {
    const c = classifyThrownError(
      new EgressError('deadline-exceeded', 'too slow'),
    );
    expect(c.errorClass).toBe('egress-blocked');
    expect(c.transient).toBe(false);
  });

  it('classifies a generic network error as transient', () => {
    const c = classifyThrownError(new Error('socket hang up'));
    expect(c).toMatchObject({ errorClass: 'network', transient: true });
  });
});

describe('httpErrorClass', () => {
  it('buckets by status family', () => {
    expect(httpErrorClass(503)).toBe('http-5xx');
    expect(httpErrorClass(404)).toBe('http-4xx');
    expect(httpErrorClass(302)).toBe('http-other');
  });
});

describe('hasDotSegment (AUD-016)', () => {
  it.each([
    '/v1/users/../disable',
    '/v1/users/./disable',
    '..',
    '/v1/%2e%2e/x',
    '/v1/.%2E/x',
    '/v1/users\\..\\x',
    '/v1/users/..?a=1',
  ])('flags %s', (path) => {
    expect(hasDotSegment(path)).toBe(true);
  });

  it.each([
    '/v1/users/ada/disable',
    '/v1/users/...',
    '/v1/users/a.b',
    '/v1/users/%252e%252e',
    '/v1/users?next=../x',
    '',
  ])('accepts %s', (path) => {
    expect(hasDotSegment(path)).toBe(false);
  });

  it('flags a percent-encoded ".." value exactly as the URL parser collapses it', () => {
    const path = `/v1/users/${encodeURIComponent('..')}/disable`;
    expect(new URL(joinUrl('https://h.example.com', path)).pathname).toBe(
      '/v1/disable',
    );
    expect(hasDotSegment(path)).toBe(true);
  });
});

describe('extractCorrelationId — releases bodies it does not read (AUD-072)', () => {
  it('cancels the body when a Location header answers', async () => {
    const { res, cancelled } = trackedResponse({
      location: '/users/1',
      'content-type': 'application/json',
    });
    expect(await extractCorrelationId(res)).toBe('/users/1');
    expect(cancelled()).toBe(true);
  });

  it('cancels a non-JSON body', async () => {
    const { res, cancelled } = trackedResponse({ 'content-type': 'text/html' });
    expect(await extractCorrelationId(res)).toBeNull();
    expect(cancelled()).toBe(true);
  });
});

describe('tryRevealSecret (AUD-071)', () => {
  it('returns the revealed secret', async () => {
    await expect(tryRevealSecret(() => Promise.resolve('s'))).resolves.toEqual({
      ok: true,
      secret: 's',
    });
  });

  it('maps an unavailable credential to ok:false', async () => {
    await expect(
      tryRevealSecret(() => Promise.reject(new CredentialUnavailableError())),
    ).resolves.toEqual({ ok: false });
  });

  it('lets any other failure propagate', async () => {
    await expect(
      tryRevealSecret(() => Promise.reject(new Error('db down'))),
    ).rejects.toThrow('db down');
  });
});
