import 'reflect-metadata';
// The controller imports InfraService, which transitively pulls the generated Prisma client and the
// ESM `meilisearch` package (via AssetsService → SearchService); stub both so jest can load the file.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

import type { Permission } from '@lazyit/shared';
import { InfraController } from './infra.controller';
import { PERMISSION_KEY } from '../auth/require-permission.decorator';
import { InfraReportRateLimitGuard } from './infra-report-rate-limit.guard';

// Permission gating (ADR-0070 §8): assert each route carries the right @RequirePermission metadata —
// reads gate on `infra:read`, mutations on `infra:manage`, and asset-backed node create ALSO requires
// `asset:write` (AND semantics). This is the decorator-level guard the global authorization guard
// enforces at runtime; reading the metadata directly is the lightest way to lock the contract in.

/** The permissions declared by `@RequirePermission(...)` on a controller handler (or [] if none). */
function permsOf(method: keyof InfraController): Permission[] {
  const handler = InfraController.prototype[method] as unknown as object;
  return (Reflect.getMetadata(PERMISSION_KEY, handler) as Permission[]) ?? [];
}

/** The guard classes declared by `@UseGuards(...)` on a controller handler (or [] if none). */
function guardsOf(method: keyof InfraController): unknown[] {
  const handler = InfraController.prototype[method] as unknown as object;
  return (Reflect.getMetadata('__guards__', handler) as unknown[]) ?? [];
}

describe('InfraController — permission gating (ADR-0070 §8)', () => {
  it('gates every READ route on infra:read', () => {
    expect(permsOf('listNodes')).toEqual(['infra:read']);
    expect(permsOf('getNode')).toEqual(['infra:read']);
    expect(permsOf('getImpact')).toEqual(['infra:read']);
    expect(permsOf('listEdges')).toEqual(['infra:read']);
  });

  it('gates plain mutations on infra:manage', () => {
    expect(permsOf('patchPosition')).toEqual(['infra:manage']);
    expect(permsOf('updateNode')).toEqual(['infra:manage']);
    expect(permsOf('removeNode')).toEqual(['infra:manage']);
    expect(permsOf('restoreNode')).toEqual(['infra:manage']);
    expect(permsOf('createEdge')).toEqual(['infra:manage']);
    expect(permsOf('closeEdge')).toEqual(['infra:manage']);
  });

  it('requires BOTH infra:manage AND asset:write to create a (default asset-backed) node', () => {
    // AND semantics (the caller must hold every listed permission) — ADR-0070 §8.
    expect(new Set(permsOf('createNode'))).toEqual(
      new Set<Permission>(['infra:manage', 'asset:write']),
    );
  });

  it('requires BOTH infra:manage AND secret:read to attach a secret handle; detach needs only infra:manage (ADR-0073, #801)', () => {
    // Attach references a secret → layer-1 needs infra:manage + secret:read (AND); the layer-2 live
    // vault-membership check is enforced in the service. Detach is a plain topology edit (infra:manage).
    expect(new Set(permsOf('attachSecret'))).toEqual(
      new Set<Permission>(['infra:manage', 'secret:read']),
    );
    expect(permsOf('detachSecret')).toEqual(['infra:manage']);
  });
});

describe('InfraController — POST /infra/report throttling (#1134)', () => {
  it('carries the per-service-account rate-limit guard', () => {
    // The permission gate alone bounded WHO may report, never HOW MUCH — a leaked agent token was an
    // unbounded row/jsonb writer. Reading the guard metadata is the lightest way to lock the wiring
    // in: drop the decorator and the throttle silently disappears, with every other test still green.
    expect(guardsOf('report')).toContain(InfraReportRateLimitGuard);
  });

  it('gates the report route on infra:report (unchanged by the throttle)', () => {
    expect(permsOf('report')).toEqual(['infra:report']);
  });
});

describe('InfraController — forward-compatible report body (#1138)', () => {
  it('forwards the RAW body alongside the validated DTO', () => {
    // The contract root is no longer strict, so the validation pipe STRIPS unknown root keys before
    // the handler ever sees them: by the time `report` holds the DTO, what a newer agent sent is
    // already gone. The raw Express body is the only place that evidence still exists, so the handler
    // must hand it on — otherwise "degrade instead of reject" quietly becomes "degrade and forget".
    const infra = { ingestReport: jest.fn() };
    const controller = new InfraController(infra as never);
    const raw = {
      agentVersion: '2.0.0',
      reportingSource: 'agent:x',
      externalId: 'x',
      reportedAt: '2026-07-31T12:00:00.000Z',
      host: { hostname: 'h' },
      deltaSince: '2026-07-31T11:00:00.000Z', // a root key this build predates
    };
    const validated = { ...raw, deltaSince: undefined };
    const principal = { kind: 'service' };

    void controller.report(
      validated,
      { body: raw } as never,
      principal as never,
    );

    expect(infra.ingestReport).toHaveBeenCalledWith(validated, principal, raw);
  });
});
