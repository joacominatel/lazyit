import { createHmac } from 'node:crypto';
import type {
  EgressTransport,
  EgressTransportRequest,
} from '../../common/egress';
import { WebhookOutStepHandler } from './webhook-out.handler';
import {
  freezeMappingContext,
  type StepContext,
  type WorkflowMappingContext,
} from './step-handler';
import type {
  WebhookOutConnectionConfig,
  WebhookOutStep,
} from '@lazyit/shared';

interface Captured {
  url: URL;
  req: EgressTransportRequest;
}

function makeTransport(opts: {
  status?: number;
  json?: unknown;
  throwError?: Error;
}): { transport: EgressTransport; captured: Captured[] } {
  const captured: Captured[] = [];
  const transport: EgressTransport = (url, req) => {
    captured.push({ url, req });
    if (opts.throwError) {
      return Promise.reject(opts.throwError);
    }
    const status = opts.status ?? 200;
    const headers = new Headers();
    let bodyText = '';
    if (opts.json !== undefined) {
      bodyText = JSON.stringify(opts.json);
      headers.set('content-type', 'application/json');
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

const publicLookup = () =>
  Promise.resolve([{ address: '93.184.216.34', family: 4 as const }]);

function makeCtx(): Readonly<WorkflowMappingContext> {
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
  });
}

function makeStep(overrides: Partial<WebhookOutStep> = {}): WebhookOutStep {
  return {
    kind: 'WEBHOOK_OUT',
    key: 'notify',
    connectionId: 'conn_1',
    dataMapping: {
      event: '{{ event }}',
      email: '{{ grantee.email }}',
    },
    // Default fail-closed: a non-idempotent delivery is single-shot (a transient failure is NOT retried).
    idempotent: false,
    onError: 'fail',
    ...overrides,
  };
}

function ctxFor(
  connection: WebhookOutConnectionConfig,
  step: WebhookOutStep,
  revealSecret: () => Promise<string | null> = () => Promise.resolve(null),
): StepContext<WebhookOutConnectionConfig, WebhookOutStep> {
  return {
    connection,
    step,
    revealSecret,
    data: makeCtx(),
    meta: { runId: 'run_1', stepKey: step.key, stepIndex: 0, attempt: 1 },
  };
}

const SIGNING_SECRET = 'whsec_top_secret';

describe('WebhookOutStepHandler.execute', () => {
  it('POSTs the mapped JSON payload and succeeds', async () => {
    const handler = new WebhookOutStepHandler();
    const { transport, captured } = makeTransport({ status: 200 });
    handler.egressOptions = { transport, lookup: publicLookup };
    const connection: WebhookOutConnectionConfig = {
      kind: 'WEBHOOK_OUT',
      url: 'https://hooks.example.com/abc',
    };
    const result = await handler.execute(ctxFor(connection, makeStep()));

    expect(captured).toHaveLength(1);
    expect(captured[0].url.href).toBe('https://hooks.example.com/abc');
    expect(captured[0].req.method).toBe('POST');
    expect(captured[0].req.headers['content-type']).toBe('application/json');
    expect(JSON.parse(captured[0].req.body as string)).toEqual({
      event: 'ACCESS_GRANTED',
      email: 'ada@example.com',
    });
    expect(result.status).toBe('SUCCEEDED');
    expect(result.metadata).toMatchObject({ statusCode: 200, signed: false });
  });

  it('signs the raw body with HMAC-SHA256 when a signatureHeader + secret are set', async () => {
    const handler = new WebhookOutStepHandler();
    const { transport, captured } = makeTransport({ status: 202 });
    handler.egressOptions = { transport, lookup: publicLookup };
    const connection: WebhookOutConnectionConfig = {
      kind: 'WEBHOOK_OUT',
      url: 'https://hooks.example.com/abc',
      signatureHeader: 'X-Lazyit-Signature',
    };
    const result = await handler.execute(
      ctxFor(connection, makeStep(), () => Promise.resolve(SIGNING_SECRET)),
    );

    const sentBody = captured[0].req.body as string;
    const expected = `sha256=${createHmac('sha256', SIGNING_SECRET).update(sentBody).digest('hex')}`;
    expect(captured[0].req.headers['x-lazyit-signature']).toBe(expected);
    expect(result.status).toBe('SUCCEEDED');
    expect(result.metadata?.signed).toBe(true);
    // The signing secret never appears in the redacted metadata.
    expect(JSON.stringify(result.metadata)).not.toContain(SIGNING_SECRET);
  });

  it('fails (config error) when a signatureHeader is set but no signing secret exists', async () => {
    const handler = new WebhookOutStepHandler();
    const { transport, captured } = makeTransport({ status: 200 });
    handler.egressOptions = { transport, lookup: publicLookup };
    const connection: WebhookOutConnectionConfig = {
      kind: 'WEBHOOK_OUT',
      url: 'https://hooks.example.com/abc',
      signatureHeader: 'X-Sig',
    };
    const result = await handler.execute(
      ctxFor(connection, makeStep(), () => Promise.resolve(null)),
    );
    expect(captured).toHaveLength(0);
    expect(result.status).toBe('FAILED');
    expect(result.retryable).toBe(false);
    expect(result.metadata?.errorClass).toBe('config');
  });

  it('classifies a 5xx receiver response as transient — retryable ONLY when the step is idempotent', async () => {
    const connection: WebhookOutConnectionConfig = {
      kind: 'WEBHOOK_OUT',
      url: 'https://hooks.example.com/abc',
    };

    // Idempotent delivery: a 5xx is a transient, RETRYABLE failure.
    const idempotent = new WebhookOutStepHandler();
    idempotent.egressOptions = {
      transport: makeTransport({ status: 502 }).transport,
      lookup: publicLookup,
    };
    const r1 = await idempotent.execute(
      ctxFor(connection, makeStep({ idempotent: true })),
    );
    expect(r1.status).toBe('FAILED');
    expect(r1.retryable).toBe(true);
    expect(r1.metadata).toMatchObject({
      statusCode: 502,
      errorClass: 'http-5xx',
    });

    // Non-idempotent delivery (the default): the same 5xx is single-shot — a redelivery could double-fire.
    const nonIdempotent = new WebhookOutStepHandler();
    nonIdempotent.egressOptions = {
      transport: makeTransport({ status: 502 }).transport,
      lookup: publicLookup,
    };
    const r2 = await nonIdempotent.execute(
      ctxFor(connection, makeStep({ idempotent: false })),
    );
    expect(r2.status).toBe('FAILED');
    expect(r2.retryable).toBe(false);
  });

  it('classifies a 4xx receiver response as a permanent (non-retryable) failure', async () => {
    const handler = new WebhookOutStepHandler();
    const { transport } = makeTransport({ status: 400 });
    handler.egressOptions = { transport, lookup: publicLookup };
    const connection: WebhookOutConnectionConfig = {
      kind: 'WEBHOOK_OUT',
      url: 'https://hooks.example.com/abc',
    };
    const result = await handler.execute(ctxFor(connection, makeStep()));
    expect(result.status).toBe('FAILED');
    expect(result.retryable).toBe(false);
    expect(result.metadata?.errorClass).toBe('http-4xx');
  });
});
