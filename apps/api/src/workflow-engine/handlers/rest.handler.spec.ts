import type {
  EgressTransport,
  EgressTransportRequest,
} from '../../common/egress';
import { RestStepHandler } from './rest.handler';
import {
  freezeMappingContext,
  type StepContext,
  type WorkflowMappingContext,
} from './step-handler';
import type { RestConnectionConfig, RestStep } from '@lazyit/shared';

interface Captured {
  url: URL;
  req: EgressTransportRequest;
}

/** A capturing fake egress transport (no live network), plus the list of requests it saw. */
function makeTransport(opts: {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
  throwError?: Error;
}): { transport: EgressTransport; captured: Captured[] } {
  const captured: Captured[] = [];
  const transport: EgressTransport = (url, req) => {
    captured.push({ url, req });
    if (opts.throwError) {
      return Promise.reject(opts.throwError);
    }
    const status = opts.status ?? 200;
    const headers = new Headers(opts.headers ?? {});
    let bodyText = '';
    if (opts.json !== undefined) {
      bodyText = JSON.stringify(opts.json);
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
    }
    return Promise.resolve({
      status,
      statusText: '',
      headers,
      toResponse: () =>
        new Response(bodyText.length > 0 ? bodyText : null, {
          status,
          headers,
        }),
      discard: () => {},
    });
  };
  return { transport, captured };
}

/** A DNS lookup that always resolves to a PUBLIC IP (so the egress guard admits the target). */
const publicLookup = () =>
  Promise.resolve([{ address: '93.184.216.34', family: 4 as const }]);
/** A DNS lookup that resolves to a PRIVATE IP (the egress guard must deny — public-only v1). */
const privateLookup = () =>
  Promise.resolve([{ address: '10.0.0.5', family: 4 as const }]);

function makeCtx(
  overrides: Partial<WorkflowMappingContext> = {},
): Readonly<WorkflowMappingContext> {
  return freezeMappingContext({
    event: 'ACCESS_GRANTED',
    grantee: {
      id: 'usr_1',
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
    },
    application: { id: 'app_1', name: 'Jira' },
    grant: {
      id: 'grant_1',
      accessLevel: 'developer',
      grantedAt: '2026-06-08T00:00:00.000Z',
      expiresAt: null,
    },
    steps: {},
    ...overrides,
  });
}

function makeStep(overrides: Partial<RestStep> = {}): RestStep {
  return {
    kind: 'REST',
    key: 'create-user',
    connectionId: 'conn_1',
    method: 'POST',
    path: '/v3/user/{{ grantee.id }}',
    dataMapping: { emailAddress: '{{ grantee.email }}' },
    idempotent: false,
    onError: 'fail',
    ...overrides,
  };
}

function makeCtxFor(
  connection: RestConnectionConfig,
  step: RestStep,
  opts: {
    revealSecret?: () => Promise<string | null>;
    data?: Readonly<WorkflowMappingContext>;
  } = {},
): StepContext<RestConnectionConfig, RestStep> {
  return {
    connection,
    step,
    revealSecret: opts.revealSecret ?? (() => Promise.resolve(null)),
    data: opts.data ?? makeCtx(),
    meta: { runId: 'run_1', stepKey: step.key, stepIndex: 0, attempt: 1 },
  };
}

const SECRET = 'jira-token-XYZ';

describe('RestStepHandler.execute', () => {
  it('builds the request (URL + body + bearer auth), captures correlation, redacts the secret', async () => {
    const handler = new RestStepHandler();
    const { transport, captured } = makeTransport({
      status: 201,
      json: { id: 'jira-acc-123' },
    });
    handler.egressOptions = { transport, lookup: publicLookup };

    const connection: RestConnectionConfig = {
      kind: 'REST',
      baseUrl: 'https://api.example.com',
      authScheme: 'BEARER',
      defaultHeaders: { Accept: 'application/json' },
    };
    const result = await handler.execute(
      makeCtxFor(connection, makeStep(), {
        revealSecret: () => Promise.resolve(SECRET),
      }),
    );

    expect(captured).toHaveLength(1);
    const { url, req } = captured[0];
    expect(url.href).toBe('https://api.example.com/v3/user/usr_1');
    expect(req.method).toBe('POST');
    expect(req.headers['authorization']).toBe(`Bearer ${SECRET}`);
    expect(req.headers['accept']).toBe('application/json');
    expect(req.headers['content-type']).toBe('application/json');
    expect(JSON.parse(req.body as string)).toEqual({
      emailAddress: 'ada@example.com',
    });

    expect(result.status).toBe('SUCCEEDED');
    expect(result.externalCorrelationId).toBe('jira-acc-123');
    expect(result.metadata).toMatchObject({
      method: 'POST',
      targetHost: 'api.example.com',
      statusCode: 201,
      mappedFields: ['emailAddress'],
    });
    // The revealed secret must NEVER appear in the redacted metadata.
    expect(JSON.stringify(result.metadata)).not.toContain(SECRET);
  });

  it('supports the HEADER auth scheme with a custom header name', async () => {
    const handler = new RestStepHandler();
    const { transport, captured } = makeTransport({ status: 200, json: {} });
    handler.egressOptions = { transport, lookup: publicLookup };
    const connection: RestConnectionConfig = {
      kind: 'REST',
      baseUrl: 'https://api.example.com',
      authScheme: 'HEADER',
      authHeaderName: 'X-Api-Key',
    };
    await handler.execute(
      makeCtxFor(
        connection,
        makeStep({ method: 'GET', dataMapping: undefined }),
        {
          revealSecret: () => Promise.resolve(SECRET),
        },
      ),
    );
    expect(captured[0].req.headers['x-api-key']).toBe(SECRET);
    expect(captured[0].req.headers['authorization']).toBeUndefined();
    expect(captured[0].req.body == null).toBe(true);
  });

  it('sends no auth header for scheme NONE', async () => {
    const handler = new RestStepHandler();
    const { transport, captured } = makeTransport({ status: 200, json: {} });
    handler.egressOptions = { transport, lookup: publicLookup };
    const connection: RestConnectionConfig = {
      kind: 'REST',
      baseUrl: 'https://api.example.com',
      authScheme: 'NONE',
    };
    const result = await handler.execute(
      makeCtxFor(
        connection,
        makeStep({ method: 'GET', dataMapping: undefined }),
      ),
    );
    expect(captured[0].req.headers['authorization']).toBeUndefined();
    expect(result.status).toBe('SUCCEEDED');
  });

  it('percent-encodes ctx interpolated into the path (no traversal / origin change)', async () => {
    const handler = new RestStepHandler();
    const { transport, captured } = makeTransport({ status: 200, json: {} });
    handler.egressOptions = { transport, lookup: publicLookup };
    const connection: RestConnectionConfig = {
      kind: 'REST',
      baseUrl: 'https://api.example.com',
      authScheme: 'NONE',
    };
    const data = makeCtx({
      grantee: {
        id: '../../admin',
        email: 'a@b.c',
        firstName: 'A',
        lastName: 'B',
      },
    });
    await handler.execute(
      makeCtxFor(
        connection,
        makeStep({ method: 'GET', dataMapping: undefined }),
        {
          data,
        },
      ),
    );
    expect(captured[0].url.href).toBe(
      'https://api.example.com/v3/user/..%2F..%2Fadmin',
    );
    expect(captured[0].url.hostname).toBe('api.example.com');
  });

  it('classifies a 4xx as a permanent (non-retryable) failure', async () => {
    const handler = new RestStepHandler();
    const { transport } = makeTransport({ status: 404 });
    handler.egressOptions = { transport, lookup: publicLookup };
    const connection: RestConnectionConfig = {
      kind: 'REST',
      baseUrl: 'https://api.example.com',
      authScheme: 'NONE',
    };
    const result = await handler.execute(
      makeCtxFor(connection, makeStep({ idempotent: true })),
    );
    expect(result.status).toBe('FAILED');
    expect(result.retryable).toBe(false);
    expect(result.metadata).toMatchObject({
      statusCode: 404,
      errorClass: 'http-4xx',
    });
  });

  it('classifies a 5xx as transient — retryable ONLY when the step is idempotent', async () => {
    const connection: RestConnectionConfig = {
      kind: 'REST',
      baseUrl: 'https://api.example.com',
      authScheme: 'NONE',
    };

    const idempotent = new RestStepHandler();
    idempotent.egressOptions = {
      transport: makeTransport({ status: 503 }).transport,
      lookup: publicLookup,
    };
    const r1 = await idempotent.execute(
      makeCtxFor(connection, makeStep({ idempotent: true })),
    );
    expect(r1.status).toBe('FAILED');
    expect(r1.retryable).toBe(true);

    const nonIdempotent = new RestStepHandler();
    nonIdempotent.egressOptions = {
      transport: makeTransport({ status: 503 }).transport,
      lookup: publicLookup,
    };
    const r2 = await nonIdempotent.execute(
      makeCtxFor(connection, makeStep({ idempotent: false })),
    );
    expect(r2.status).toBe('FAILED');
    expect(r2.retryable).toBe(false);
  });

  it('classifies a transport/network error as transient', async () => {
    const handler = new RestStepHandler();
    handler.egressOptions = {
      transport: makeTransport({ throwError: new Error('socket hang up') })
        .transport,
      lookup: publicLookup,
    };
    const connection: RestConnectionConfig = {
      kind: 'REST',
      baseUrl: 'https://api.example.com',
      authScheme: 'NONE',
    };
    const result = await handler.execute(
      makeCtxFor(connection, makeStep({ idempotent: true })),
    );
    expect(result.status).toBe('FAILED');
    expect(result.metadata?.errorClass).toBe('network');
    expect(result.retryable).toBe(true);
  });

  it('is denied by the egress guard for a private target (public-only v1), non-retryable', async () => {
    const handler = new RestStepHandler();
    const { transport, captured } = makeTransport({ status: 200 });
    // The guard resolves the host to a private IP and rejects BEFORE the transport is called.
    handler.egressOptions = { transport, lookup: privateLookup };
    const connection: RestConnectionConfig = {
      kind: 'REST',
      baseUrl: 'https://internal.example.com',
      authScheme: 'NONE',
    };
    const result = await handler.execute(
      makeCtxFor(
        connection,
        makeStep({ method: 'GET', dataMapping: undefined }),
      ),
    );
    expect(captured).toHaveLength(0);
    expect(result.status).toBe('FAILED');
    expect(result.retryable).toBe(false);
    expect(result.metadata?.errorClass).toBe('egress-blocked');
  });

  it('fails (config error) when an auth scheme needs a secret but none is configured', async () => {
    const handler = new RestStepHandler();
    const { transport, captured } = makeTransport({ status: 200 });
    handler.egressOptions = { transport, lookup: publicLookup };
    const connection: RestConnectionConfig = {
      kind: 'REST',
      baseUrl: 'https://api.example.com',
      authScheme: 'BEARER',
    };
    const result = await handler.execute(
      makeCtxFor(connection, makeStep(), {
        revealSecret: () => Promise.resolve(null),
      }),
    );
    expect(captured).toHaveLength(0);
    expect(result.status).toBe('FAILED');
    expect(result.retryable).toBe(false);
    expect(result.metadata?.errorClass).toBe('config');
  });
});

describe('RestStepHandler.testConnection', () => {
  it('probes the base URL and returns a redacted diagnostic (no health path ⇒ GET /)', async () => {
    const handler = new RestStepHandler();
    const { transport, captured } = makeTransport({
      status: 200,
      json: { ok: true },
    });
    handler.egressOptions = { transport, lookup: publicLookup };
    const connection: RestConnectionConfig = {
      kind: 'REST',
      baseUrl: 'https://api.example.com',
      authScheme: 'BEARER',
    };
    const result = await handler.testConnection({
      connection,
      revealSecret: () => Promise.resolve(SECRET),
      meta: {},
    });
    expect(captured[0].req.method).toBe('GET');
    expect(captured[0].url.href).toBe('https://api.example.com/');
    expect(captured[0].req.headers['authorization']).toBe(`Bearer ${SECRET}`);
    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.probedPath).toBe('/');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('targets joinUrl(baseUrl, healthCheckPath) when a health path is configured (#344)', async () => {
    const handler = new RestStepHandler();
    const { transport, captured } = makeTransport({ status: 204 });
    handler.egressOptions = { transport, lookup: publicLookup };
    const connection: RestConnectionConfig = {
      kind: 'REST',
      // A trailing slash on baseUrl + a leading slash on the path must normalize to ONE separator.
      baseUrl: 'https://api.example.com/',
      authScheme: 'NONE',
      healthCheckPath: '/api/healthz',
    };
    const result = await handler.testConnection({
      connection,
      revealSecret: () => Promise.resolve(null),
      meta: {},
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].url.href).toBe('https://api.example.com/api/healthz');
    // The host is fixed by baseUrl — the path can never change the origin.
    expect(captured[0].url.hostname).toBe('api.example.com');
    expect(captured[0].req.method).toBe('GET');
    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(204);
    expect(result.probedPath).toBe('/api/healthz');
  });

  it('uses the configured READ-ONLY probe method (HEAD) — never a mutation (#344)', async () => {
    const handler = new RestStepHandler();
    const { transport, captured } = makeTransport({ status: 200 });
    handler.egressOptions = { transport, lookup: publicLookup };
    const connection: RestConnectionConfig = {
      kind: 'REST',
      baseUrl: 'https://api.example.com',
      authScheme: 'NONE',
      healthCheckPath: '/health',
      healthCheckMethod: 'HEAD',
    };
    await handler.testConnection({
      connection,
      revealSecret: () => Promise.resolve(null),
      meta: {},
    });
    expect(captured[0].req.method).toBe('HEAD');
    expect(['POST', 'PUT', 'PATCH', 'DELETE']).not.toContain(
      captured[0].req.method,
    );
    expect(captured[0].url.href).toBe('https://api.example.com/health');
  });

  it('a configured health path cannot re-point the host (anti-SSRF) and still rides the egress guard', async () => {
    const handler = new RestStepHandler();
    const { transport, captured } = makeTransport({ status: 200 });
    handler.egressOptions = { transport, lookup: publicLookup };
    const connection: RestConnectionConfig = {
      kind: 'REST',
      baseUrl: 'https://api.example.com',
      authScheme: 'NONE',
      // Even a path that LOOKS like an absolute URL stays appended under the fixed baseUrl host.
      healthCheckPath: 'https://attacker.example.net/steal',
    };
    await handler.testConnection({
      connection,
      revealSecret: () => Promise.resolve(null),
      meta: {},
    });
    expect(captured[0].url.hostname).toBe('api.example.com');
    expect(captured[0].url.hostname).not.toBe('attacker.example.net');
  });

  it('reports a failure (with status + probed path) when the upstream rejects the health path', async () => {
    const handler = new RestStepHandler();
    const { transport } = makeTransport({ status: 503 });
    handler.egressOptions = { transport, lookup: publicLookup };
    const connection: RestConnectionConfig = {
      kind: 'REST',
      baseUrl: 'https://api.example.com',
      authScheme: 'NONE',
      healthCheckPath: '/status',
    };
    const result = await handler.testConnection({
      connection,
      revealSecret: () => Promise.resolve(null),
      meta: {},
    });
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(503);
    expect(result.probedPath).toBe('/status');
  });
});
