jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import { NotFoundException } from '@nestjs/common';
import { WorkflowConnectionsService } from './workflow-connections.service';
import { ConnectorRegistry } from '../connectors.registry';
import { RestStepHandler } from '../handlers/rest.handler';
import { WebhookOutStepHandler } from '../handlers/webhook-out.handler';
import { ManualStepHandler } from '../handlers/manual.handler';
import type {
  EgressTransport,
  EgressTransportRequest,
} from '../../common/egress';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionResolverService } from '../../auth/permission-resolver.service';
import type { SecretService } from '../secrets/secret.service';

/**
 * C3 — TEST CONNECTION (frontend §4c). A single bounded, READ-ONLY probe of a connection: it delegates
 * to the connector handler's side-effect-free `testConnection` (REST → an auth'd GET through the egress
 * guard), NEVER provisions / POSTs a mutation, and NEVER echoes the stored secret (INV-6). A MANUAL /
 * WEBHOOK_OUT connection (no read-only probe) returns a clear "nothing to test" result. The request id
 * (ADR-0031) is surfaced on the outcome.
 */

const SECRET = 'super-secret-token-XYZ';
const REQUEST_ID = 'req-c3-123';

interface Captured {
  url: URL;
  req: EgressTransportRequest;
}

/** A capturing fake egress transport (no live network), plus the requests it saw. */
function makeTransport(opts: { status?: number; throwError?: Error }): {
  transport: EgressTransport;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const transport: EgressTransport = (url, req) => {
    captured.push({ url, req });
    if (opts.throwError) {
      return Promise.reject(opts.throwError);
    }
    const status = opts.status ?? 200;
    const headers = new Headers();
    return Promise.resolve({
      status,
      statusText: '',
      headers,
      toResponse: () => new Response(null, { status, headers }),
      discard: () => {},
    });
  };
  return { transport, captured };
}

/** A DNS lookup that always resolves to a PUBLIC IP (so the egress guard admits the target). */
const publicLookup = () =>
  Promise.resolve([{ address: '93.184.216.34', family: 4 as const }]);

function buildService(opts: {
  status?: number;
  throwError?: Error;
  connection: {
    kind: string;
    config: unknown;
    secretId: string | null;
  } | null;
}) {
  const rest = new RestStepHandler();
  const { transport, captured } = makeTransport({
    status: opts.status,
    throwError: opts.throwError,
  });
  rest.egressOptions = { transport, lookup: publicLookup };
  const registry = new ConnectorRegistry(
    rest,
    new WebhookOutStepHandler(),
    new ManualStepHandler(),
  );

  const findFirst = jest.fn().mockResolvedValue(
    opts.connection
      ? {
          id: 'c1',
          applicationId: 'app1',
          deletedAt: null,
          ...opts.connection,
        }
      : null,
  );
  const prisma = {
    workflowConnection: { findFirst },
  } as unknown as PrismaService;

  const revealById = jest.fn().mockResolvedValue(SECRET);
  const secrets = { revealById } as unknown as SecretService;
  const permissions = {} as unknown as PermissionResolverService;

  const service = new WorkflowConnectionsService(
    prisma,
    permissions,
    registry,
    secrets,
  );
  return { service, captured, revealById, findFirst };
}

const REST_CONFIG = {
  kind: 'REST' as const,
  baseUrl: 'https://api.example.com',
  authScheme: 'BEARER' as const,
};

describe('WorkflowConnectionsService.test — C3', () => {
  it('probes a REST connection READ-ONLY (GET, never a mutation) and reports OK + the request id', async () => {
    const { service, captured, revealById } = buildService({
      status: 200,
      connection: { kind: 'REST', config: REST_CONFIG, secretId: 'sec1' },
    });

    const outcome = await service.test('c1', REQUEST_ID);

    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe(200);
    expect(outcome.message).toMatch(/succeeded/i);
    expect(outcome.requestId).toBe(REQUEST_ID);

    // One probe, and it is a GET — NEVER a provisioning POST/PUT/PATCH/DELETE.
    expect(captured).toHaveLength(1);
    expect(captured[0].req.method).toBe('GET');
    expect(['POST', 'PUT', 'PATCH', 'DELETE']).not.toContain(
      captured[0].req.method,
    );
    expect(captured[0].url.href).toBe('https://api.example.com/');
    // No health path configured ⇒ the probed path is the root.
    expect(outcome.probedPath).toBe('/');
    expect(outcome.message).toMatch(/at \//);
    // The credential was revealed in memory only to authenticate the probe.
    expect(revealById).toHaveBeenCalledWith('sec1');
    expect(captured[0].req.headers['authorization']).toBe(`Bearer ${SECRET}`);
  });

  it('probes the configured healthCheckPath and surfaces it in the outcome (#344)', async () => {
    const { service, captured } = buildService({
      status: 200,
      connection: {
        kind: 'REST',
        config: { ...REST_CONFIG, healthCheckPath: '/api/healthz' },
        secretId: 'sec1',
      },
    });

    const outcome = await service.test('c1', REQUEST_ID);

    expect(outcome.ok).toBe(true);
    expect(outcome.probedPath).toBe('/api/healthz');
    // The message names the path that was hit.
    expect(outcome.message).toMatch(/\/api\/healthz/);
    // Still a single READ-ONLY GET against the configured path under the FIXED host.
    expect(captured).toHaveLength(1);
    expect(captured[0].req.method).toBe('GET');
    expect(captured[0].url.href).toBe('https://api.example.com/api/healthz');
  });

  it('NEVER echoes the stored secret in the outcome (INV-6)', async () => {
    const { service } = buildService({
      status: 200,
      connection: { kind: 'REST', config: REST_CONFIG, secretId: 'sec1' },
    });

    const outcome = await service.test('c1', REQUEST_ID);

    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    expect(outcome.message).not.toContain(SECRET);
  });

  it('reports a failure (with status) when the upstream rejects the probe', async () => {
    const { service, captured } = buildService({
      status: 401,
      connection: { kind: 'REST', config: REST_CONFIG, secretId: 'sec1' },
    });

    const outcome = await service.test('c1', REQUEST_ID);

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(401);
    expect(outcome.message).toMatch(/failed/i);
    expect(outcome.requestId).toBe(REQUEST_ID);
    // Still a single READ-ONLY GET, even on failure.
    expect(captured[0].req.method).toBe('GET');
  });

  it('reports a redacted failure (no body/secret) on a network/transport error', async () => {
    const { service } = buildService({
      throwError: new Error('socket hang up'),
      connection: { kind: 'REST', config: REST_CONFIG, secretId: 'sec1' },
    });

    const outcome = await service.test('c1', REQUEST_ID);

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBeUndefined();
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  it('returns a clear "nothing to test" for a MANUAL connection — no network, no reveal', async () => {
    const { service, captured, revealById } = buildService({
      connection: {
        kind: 'MANUAL',
        config: { kind: 'MANUAL' },
        secretId: null,
      },
    });

    const outcome = await service.test('c1', REQUEST_ID);

    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBeUndefined();
    expect(outcome.message).toMatch(/nothing to test/i);
    expect(outcome.requestId).toBe(REQUEST_ID);
    // A MANUAL connection performs NO external call and reveals NO secret.
    expect(captured).toHaveLength(0);
    expect(revealById).not.toHaveBeenCalled();
  });

  it('returns "nothing to probe" for a WEBHOOK_OUT connection (write-only) — no network', async () => {
    const { service, captured } = buildService({
      connection: {
        kind: 'WEBHOOK_OUT',
        config: { kind: 'WEBHOOK_OUT', url: 'https://hooks.example.com/x' },
        secretId: 'sec1',
      },
    });

    const outcome = await service.test('c1', REQUEST_ID);

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toMatch(/write-only|nothing to probe/i);
    expect(captured).toHaveLength(0);
  });

  it('404s when the connection is missing', async () => {
    const { service } = buildService({ connection: null });

    await expect(service.test('missing', REQUEST_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
