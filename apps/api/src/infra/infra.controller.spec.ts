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

// Permission gating (ADR-0070 §8): assert each route carries the right @RequirePermission metadata —
// reads gate on `infra:read`, mutations on `infra:manage`, and asset-backed node create ALSO requires
// `asset:write` (AND semantics). This is the decorator-level guard the global authorization guard
// enforces at runtime; reading the metadata directly is the lightest way to lock the contract in.

/** The permissions declared by `@RequirePermission(...)` on a controller handler (or [] if none). */
function permsOf(method: keyof InfraController): Permission[] {
  const handler = InfraController.prototype[method] as unknown as object;
  return (Reflect.getMetadata(PERMISSION_KEY, handler) as Permission[]) ?? [];
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
