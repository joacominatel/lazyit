import 'reflect-metadata';
// The controller imports InfraService, which transitively pulls the generated Prisma client and the
// ESM `meilisearch` package (via AssetsService → SearchService); stub both so jest can load the file.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

import { BadRequestException } from '@nestjs/common';
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
    // The re-image adoption hint is a READ — it only suggests a merge, it never performs one (#1141).
    expect(permsOf('identityMatches')).toEqual(['infra:read']);
    // The append-only fact history (#1143). A READ, and the ONLY route this table has: nothing but
    // the report ingest ever appends to it, so there is deliberately no write permission to gate.
    expect(permsOf('listNodeChanges')).toEqual(['infra:read']);
    // The agent fleet view (ADR-0094 §4, #1206). A READ and only a read — it computes version
    // buckets and projects one string out of `specs`; it writes nothing and pushes nothing to a host.
    expect(permsOf('getAgentFleet')).toEqual(['infra:read']);
    // The canvas's own bounded graph read (#1152). It is the SAME data the node list exposes, just
    // projected — so it must carry the SAME gate. A cheaper gate here would be a way to read the
    // estate's topology without infra:read.
    expect(permsOf('listGraphNodes')).toEqual(['infra:read']);
    expect(permsOf('listGraphEdges')).toEqual(['infra:read']);
  });

  describe('the node list page params (#1152)', () => {
    // A real (stubbed) service, so a params failure can only ever be a 400 from the parsing — never a
    // "not a function" from an empty stand-in that would pass the assertion for the wrong reason.
    const listNodes = jest.fn().mockReturnValue('page');
    const controller = new InfraController(
      { listNodes } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    /** Named call-through, so adding a filter param never silently re-points these positionals. */
    function list(params: Record<string, string>) {
      return controller.listNodes(params);
    }

    beforeEach(() => listNodes.mockClear());

    // ADR-0030: an over-max `limit` is REJECTED, never clamped — so a client can never believe it
    // asked for more than it got. A clamp is the failure mode this contract exists to forbid.
    it.each(['201', '0', '-1', 'abc', '1.5'])(
      'rejects limit=%p with a 400 rather than clamping it',
      (limit) => {
        expect(() => list({ limit })).toThrow(BadRequestException);
        expect(listNodes).not.toHaveBeenCalled();
      },
    );

    it('accepts the hard maximum page size (200) — the PENDING tray asks for exactly this', () => {
      void list({ state: 'PENDING', limit: '200' });

      expect(listNodes).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'PENDING' }),
        expect.objectContaining({ limit: 200, offset: 0 }),
      );
    });

    it('defaults to the house page size when no window is asked for', () => {
      void list({});

      expect(listNodes).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ limit: 50, offset: 0 }),
      );
    });

    it.each(['ids', 'assetIds'] as const)(
      'rejects a malformed %s element with a 400 (never a silently empty filter)',
      (param) => {
        expect(() => list({ [param]: 'not-a-cuid' })).toThrow(
          BadRequestException,
        );
      },
    );

    it.each(['ids', 'assetIds'] as const)(
      'rejects an over-cap %s batch with a 400 (bounded like GET /users?ids=)',
      (param) => {
        // Without a cap the page fix would trade one unbounded read for an unbounded IN list a
        // client can post in a query string. 201 cuids, one over MAX_PAGE_LIMIT.
        const over = Array.from(
          { length: 201 },
          (_, i) => `c${String(i).padStart(24, 'x')}`,
        ).join(',');

        expect(() => list({ [param]: over })).toThrow(BadRequestException);
      },
    );

    it('passes `q` and `source` through as filters the DATABASE applies', () => {
      // Both exist because the page made client-side scanning wrong: an in-memory search over one
      // window is a false "no results", and "does any agent node exist?" cannot be answered by
      // looking at 50 rows.
      void list({ q: 'web-01', source: 'AGENT', limit: '1' });

      expect(listNodes).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'web-01', source: 'AGENT' }),
        expect.objectContaining({ limit: 1 }),
      );
    });

    it.each(['HOST', 'CHILD'])(
      'accepts role=%s and dispatches it as an identity-role filter',
      (role) => {
        void list({ role });

        expect(listNodes).toHaveBeenCalledWith(
          expect.objectContaining({ role }),
          expect.anything(),
        );
      },
    );

    it.each(['VM', 'CONTAINER', 'host', ''])(
      'rejects invalid role=%p',
      (role) => {
        expect(() => list({ role })).toThrow(BadRequestException);
        expect(listNodes).not.toHaveBeenCalled();
      },
    );

    it.each(['deleted', 'typo'])(
      'rejects unknown query key %s before dispatch',
      (key) => {
        expect(() => list({ [key]: 'active' })).toThrow(BadRequestException);
        expect(listNodes).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['kind', 'VM'],
      ['status', 'ONLINE'],
      ['state', 'PENDING'],
      ['source', 'AGENT'],
      ['role', 'CHILD'],
      ['ids', 'cxxxxxxxxxxxxxxxxxxxxxxxx'],
      ['assetIds', 'cxxxxxxxxxxxxxxxxxxxxxxxx'],
      ['q', 'web'],
      ['limit', '25'],
      ['offset', '25'],
      ['page', '2'],
      ['sort', 'label'],
      ['dir', 'desc'],
    ])('accepts documented query key %s', (key, value) => {
      expect(() => list({ [key]: value })).not.toThrow();
      expect(listNodes).toHaveBeenCalledTimes(1);
    });
  });

  it('dispatches the bounded graph-edge read through the infra:read route', () => {
    const listGraphEdges = jest.fn().mockReturnValue('edges');
    const controller = new InfraController(
      { listGraphEdges } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    expect(controller.listGraphEdges()).toBe('edges');
    expect(listGraphEdges).toHaveBeenCalledTimes(1);
  });

  describe('the Changes page params (#1143)', () => {
    // `limit` reaches a `take` and `cursor` a keyset `WHERE id <`. A silently coerced NaN would page
    // unpredictably, so both are REFUSED rather than defaulted — which the entity note promises.
    const controller = new InfraController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    it.each(['abc', '0', '-1', '1.5', ''])(
      'rejects limit=%p with a 400',
      (limit) => {
        expect(() => controller.listNodeChanges('n-1', limit)).toThrow(
          BadRequestException,
        );
      },
    );

    it.each(['abc', '0', '-1'])('rejects cursor=%p with a 400', (cursor) => {
      expect(() =>
        controller.listNodeChanges('n-1', undefined, cursor),
      ).toThrow(BadRequestException);
    });

    it('passes a valid pair straight through, and omits what was not sent', () => {
      const infra = { listNodeFactChanges: jest.fn() };
      const ok = new InfraController(
        infra as never,
        {} as never,
        {} as never,
        {} as never,
      );

      void ok.listNodeChanges('n-1', '25', '900');
      expect(infra.listNodeFactChanges).toHaveBeenCalledWith('n-1', {
        limit: 25,
        cursor: 900,
      });

      void ok.listNodeChanges('n-1');
      expect(infra.listNodeFactChanges).toHaveBeenLastCalledWith('n-1', {});
    });
  });

  it('gates the re-key/merge on infra:manage AND refuses a machine caller (#1141)', () => {
    // Merging moves a dedup key between nodes and archives one of them — human curation, exactly like
    // confirming a proposal. A reporting agent must never be able to re-key its own way out of the
    // review tray, so the same HumanOnlyGuard that protects confirm protects this.
    expect(permsOf('mergeNodeInto')).toEqual(['infra:manage']);
    expect(
      guardsOf('mergeNodeInto').map((g) => (g as { name: string }).name),
    ).toContain('HumanOnlyGuard');
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

describe('InfraController — the review tray at scale (#1145)', () => {
  it('gates bulk confirm exactly as the single confirm is gated, machine callers included', () => {
    // Bulk confirm IS the single confirm run per item, so anything weaker here would be a second,
    // cheaper door onto the same write — and the human gate ADR-0074 §1 chose lives on that door.
    expect(new Set(permsOf('bulkConfirm'))).toEqual(
      new Set<Permission>(['infra:manage', 'asset:write']),
    );
    expect(
      guardsOf('bulkConfirm').map((g) => (g as { name: string }).name),
    ).toContain('HumanOnlyGuard');
  });

  it('gates bulk discard exactly as the single discard is gated', () => {
    expect(permsOf('bulkDiscard')).toEqual(['infra:manage']);
  });

  it('refuses a MACHINE author for every auto-confirm rule write', () => {
    // The load-bearing guard of the whole amendment: a rule is the human decision that lets a later
    // confirm happen with no human present. A service account authoring one would be the reporting
    // agent granting itself the confirm §1/§8 denies it.
    for (const route of [
      'createAutoConfirmRule',
      'updateAutoConfirmRule',
      'removeAutoConfirmRule',
    ] as const) {
      expect(
        guardsOf(route).map((g) => (g as { name: string }).name),
      ).toContain('HumanOnlyGuard');
    }
  });

  it('gates rule reads on infra:read and rule authoring on infra:manage + asset:write', () => {
    expect(permsOf('listAutoConfirmRules')).toEqual(['infra:read']);
    // Authoring a rule authors a decision that will later mint Assets, so it carries the same pair
    // the confirm it automates carries.
    expect(new Set(permsOf('createAutoConfirmRule'))).toEqual(
      new Set<Permission>(['infra:manage', 'asset:write']),
    );
    expect(new Set(permsOf('updateAutoConfirmRule'))).toEqual(
      new Set<Permission>(['infra:manage', 'asset:write']),
    );
    expect(permsOf('removeAutoConfirmRule')).toEqual(['infra:manage']);
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
    const autoConfirm = { list: jest.fn() };
    // The #1140 policy service is a constructor dependency of the controller but plays no part in
    // the report route — the policy is resolved inside `ingestReport`, not by the handler.
    const controller = new InfraController(
      infra as never,
      autoConfirm as never,
      {} as never,
      {} as never,
    );
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
