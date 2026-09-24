import type { AiProviderKind } from '@lazyit/shared';

import {
  EgressError,
  type DnsLookup,
  type EgressTransport,
  type EgressTransportRequest,
} from '../../common/egress';
import {
  createProviderFetch,
  privateHostScope,
  PROVIDER_DEADLINE_MS,
  PROVIDER_IDLE_TIMEOUT_MS,
  type ProviderEgressTarget,
} from './provider-fetch';
import { classifyProviderError } from './provider-errors';
import { SECRET_KEY } from './provider.harness-spec';

/**
 * INV-AI-7 / security.md §6.4, G1 "Egress": every provider request goes through the egress guard with
 * the provider policy — https only, no redirects, private addresses denied except the OpenAI-compatible
 * provider's own host behind `allowPrivateNetwork`, loopback and IMDS never. The guard's real validation
 * runs; only DNS and the socket are stubbed.
 */

const HOSTS: Record<string, string> = {
  'api.anthropic.com': '160.79.104.10',
  'llm.lan': '10.0.0.5',
  'other.lan': '10.0.0.9',
  'llm.v6.lan': 'fd00::5',
  localhost: '127.0.0.1',
  'rebind.lan': '127.0.0.1',
  'metadata.lan': '169.254.169.254',
  'public-http.example': '93.184.216.34',
};

function harness(target: Partial<ProviderEgressTarget>) {
  const dialed: Array<{ url: string; req: EgressTransportRequest }> = [];
  const lookups: string[] = [];
  const lookup: DnsLookup = (hostname) => {
    lookups.push(hostname);
    const address = HOSTS[hostname];
    return address
      ? Promise.resolve([{ address, family: address.includes(':') ? 6 : 4 }])
      : Promise.reject(new Error('ENOTFOUND'));
  };
  let status = 200;
  let headers = new Headers();
  const transport: EgressTransport = (url, req) => {
    dialed.push({ url: url.href, req });
    return Promise.resolve({
      status,
      statusText: '',
      headers,
      toResponse: () => new Response('{}', { status, headers }),
      discard: () => undefined,
    });
  };
  const fetch = createProviderFetch(
    {
      kind: 'openai-compatible',
      baseUrl: null,
      allowPrivateNetwork: false,
      ...target,
    },
    { lookup, transport },
  );
  return {
    fetch,
    dialed,
    lookups,
    respondWith(next: number, nextHeaders: Record<string, string>) {
      status = next;
      headers = new Headers(nextHeaders);
    },
  };
}

async function refusal(promise: Promise<unknown>): Promise<EgressError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EgressError);
  return err as EgressError;
}

const privateToggle: Partial<ProviderEgressTarget> = {
  kind: 'openai-compatible',
  baseUrl: 'https://llm.lan:8443/v1',
  allowPrivateNetwork: true,
};

describe('provider fetch — the egress policy for LLM traffic', () => {
  it('reaches a public provider host over https, pinned, with the LLM timeouts and the key header intact', async () => {
    const h = harness({ kind: 'anthropic' });

    const res = await h.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': SECRET_KEY },
      body: '{}',
    });

    expect(res.status).toBe(200);
    expect(h.dialed).toHaveLength(1);
    expect(h.dialed[0].req.pin).toEqual({
      address: '160.79.104.10',
      family: 4,
    });
    expect(h.dialed[0].req.headers['x-api-key']).toBe(SECRET_KEY);
    // Both budgets, always: without deadlineMs the transport would cut long generations (W1-B finding 3).
    expect(h.dialed[0].req.timeoutMs).toBe(PROVIDER_IDLE_TIMEOUT_MS);
    expect(h.dialed[0].req.deadlineMs).toBe(PROVIDER_DEADLINE_MS);
  });

  it.each<AiProviderKind>([
    'anthropic',
    'openai',
    'google',
    'openai-compatible',
  ])('refuses a private host for %s when the toggle is off', async (kind) => {
    const h = harness({ kind, baseUrl: 'https://llm.lan/v1' });

    const err = await refusal(h.fetch('https://llm.lan/v1/models'));

    expect(err.reason).toBe('blocked-address');
    expect(h.dialed).toHaveLength(0);
  });

  it.each<AiProviderKind>(['anthropic', 'openai', 'google'])(
    'refuses a private host for %s even with allowPrivateNetwork set (the toggle is OpenAI-compatible only)',
    async (kind) => {
      const h = harness({
        kind,
        baseUrl: 'https://llm.lan/v1',
        allowPrivateNetwork: true,
      });

      await refusal(h.fetch('https://llm.lan/v1/models'));
      expect(h.dialed).toHaveLength(0);
    },
  );

  it('lets the OpenAI-compatible provider reach its configured private host when the toggle is on', async () => {
    const h = harness(privateToggle);

    await h.fetch('https://llm.lan:8443/v1/chat/completions', {
      method: 'POST',
      body: '{}',
    });

    expect(h.dialed).toHaveLength(1);
    expect(h.dialed[0].req.pin.address).toBe('10.0.0.5');
  });

  it('scopes the exception to that host and port only', async () => {
    const h = harness(privateToggle);

    await refusal(h.fetch('https://other.lan:8443/v1/models'));
    await refusal(h.fetch('https://llm.lan:9999/v1/models'));
    await refusal(h.fetch('https://10.0.0.5:8443/v1/models'));
    expect(h.dialed).toHaveLength(0);
  });

  it('supports an IPv6 ULA base URL', async () => {
    const h = harness({
      ...privateToggle,
      baseUrl: 'https://[fd00::5]:8443/v1',
    });

    await h.fetch('https://[fd00::5]:8443/v1/models');

    expect(h.dialed).toHaveLength(1);
  });

  it.each([
    ['localhost', 'https://localhost/v1'],
    ['127.0.0.1', 'https://127.0.0.1/v1'],
    ['[::1]', 'https://[::1]/v1'],
    ['a name resolving to loopback', 'https://rebind.lan/v1'],
    ['the cloud metadata address', 'http://169.254.169.254/latest'],
    ['a name resolving to IMDS', 'https://metadata.lan/v1'],
  ])(
    'never reaches %s, even as the configured host with the toggle on',
    async (_label, baseUrl) => {
      const h = harness({ ...privateToggle, baseUrl });

      const err = await refusal(h.fetch(`${baseUrl}/models`));

      expect(['blocked-address', 'scheme-not-allowed']).toContain(err.reason);
      expect(h.dialed).toHaveLength(0);
    },
  );

  it('refuses plain http for a hosted provider', async () => {
    const h = harness({
      kind: 'openai',
      baseUrl: 'http://public-http.example/v1',
    });

    const err = await refusal(h.fetch('http://public-http.example/v1/models'));

    expect(err.reason).toBe('scheme-not-allowed');
  });

  it('allows plain http only toward the scoped private host', async () => {
    const h = harness({ ...privateToggle, baseUrl: 'http://llm.lan:11434/v1' });

    await h.fetch('http://llm.lan:11434/v1/models');

    expect(h.dialed).toHaveLength(1);
    // Resolved once and dialed at exactly the address that was checked (no rebinding window).
    expect(h.lookups).toEqual(['llm.lan']);
  });

  it('refuses plain http toward a scoped host that resolves to a public address', async () => {
    const h = harness({
      ...privateToggle,
      baseUrl: 'http://public-http.example/v1',
    });

    const err = await refusal(h.fetch('http://public-http.example/v1/models'));

    expect(err.reason).toBe('scheme-not-allowed');
    expect(h.dialed).toHaveLength(0);
  });

  it('refuses plain http when the toggle is off', async () => {
    const h = harness({
      kind: 'openai-compatible',
      baseUrl: 'http://llm.lan/v1',
    });

    const err = await refusal(h.fetch('http://llm.lan/v1/models'));

    expect(err.reason).toBe('scheme-not-allowed');
  });

  it('follows no redirect, and the refusal is classified EGRESS_DENIED', async () => {
    const h = harness({ kind: 'anthropic' });
    h.respondWith(302, { location: 'http://169.254.169.254/latest/meta-data' });

    const err = await refusal(h.fetch('https://api.anthropic.com/v1/messages'));

    expect(err.reason).toBe('too-many-redirects');
    expect(h.dialed).toHaveLength(1);
    expect(classifyProviderError(err, { contextLimit: /x/ }).code).toBe(
      'EGRESS_DENIED',
    );
  });

  it('carries neither the key nor the request in a refusal', async () => {
    const h = harness({ kind: 'openai', baseUrl: 'https://llm.lan/v1' });

    const err = await refusal(
      h.fetch('https://llm.lan/v1/responses', {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET_KEY}` },
        body: '{"input":"secret prompt"}',
      }),
    );

    const dump = `${err.message} ${err.stack ?? ''} ${JSON.stringify(err)}`;
    expect(dump).not.toContain(SECRET_KEY);
    expect(dump).not.toContain('secret prompt');
  });
});

describe('privateHostScope', () => {
  it('is null unless OpenAI-compatible, toggled on, with a parseable http(s) base URL', () => {
    expect(
      privateHostScope({
        kind: 'openai',
        baseUrl: 'https://x.lan',
        allowPrivateNetwork: true,
      }),
    ).toBeNull();
    expect(
      privateHostScope({
        kind: 'openai-compatible',
        baseUrl: 'https://x.lan',
        allowPrivateNetwork: false,
      }),
    ).toBeNull();
    expect(
      privateHostScope({
        kind: 'openai-compatible',
        baseUrl: null,
        allowPrivateNetwork: true,
      }),
    ).toBeNull();
    expect(
      privateHostScope({
        kind: 'openai-compatible',
        baseUrl: 'ftp://x.lan',
        allowPrivateNetwork: true,
      }),
    ).toBeNull();
    expect(
      privateHostScope({
        kind: 'openai-compatible',
        baseUrl: 'not a url',
        allowPrivateNetwork: true,
      }),
    ).toBeNull();
    expect(
      privateHostScope({
        kind: 'openai-compatible',
        baseUrl: 'http://LLM.lan/v1',
        allowPrivateNetwork: true,
      }),
    ).toEqual({ hostname: 'llm.lan', port: 80 });
  });
});
