import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { InfraService } from './infra.service';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
import { AssetsService } from '../assets/assets.service';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { ArticlesService } from '../articles/articles.service';

// Mock the generated Prisma client so the test never loads the real one (no DB). The service uses
// `Prisma` for types (erased) AND at runtime for `Prisma.PrismaClientKnownRequestError` (the P2002
// edge-conflict mapping) and `Prisma.DbNull`, so the factory provides both (defined INSIDE the
// factory — jest.mock is hoisted, an outer reference would hit the TDZ).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {
    DbNull: { __dbNull: true },
    PrismaClientKnownRequestError: class extends Error {
      constructor(
        public code: string,
        public meta?: { target?: string | string[] },
      ) {
        super(`prisma-${code}`);
      }
    },
  },
}));

// InfraService transitively imports the ESM `meilisearch` package (via AssetsService → SearchService);
// jest can't transform it. SearchService is never exercised here; this stub stops the real module load.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

import { Prisma } from '../../generated/prisma/client';

const KnownError = Prisma.PrismaClientKnownRequestError as unknown as new (
  code: string,
  meta?: { target?: string | string[] },
) => Error & { code: string; meta?: { target?: string | string[] } };

// The two raw partial-unique index names from migration 20260623193046_infra_topology (adapter-pg
// surfaces these by NAME on a P2002, since Prisma doesn't know the raw indexes from the schema).
const RUNS_ON_INDEX = 'infra_edges_source_active_runs_on_key';
const CONNECTS_TO_INDEX = 'infra_edges_connects_to_pair_active_key';

type Mock = jest.Mock;

/** The first argument of a mock's first call, typed (avoids the `any` member-access lint on .calls). */
function firstArg<T>(mock: Mock): T {
  const calls = mock.mock.calls as unknown[][];
  return calls[0][0] as T;
}

// The per-model Prisma mocks the service drives. The $transaction is mocked to invoke the callback
// with a tx client (the interactive-transaction idiom).
interface PrismaMock {
  infraNode: { findFirst: Mock; findMany: Mock; create: Mock; update: Mock };
  infraEdge: {
    findFirst: Mock;
    findMany: Mock;
    findUnique: Mock;
    create: Mock;
    update: Mock;
    updateMany: Mock;
  };
  asset: { findFirst: Mock };
  $transaction: Mock;
}

const HUMAN = { kind: 'human', user: { id: 'u-1' } } as never;

describe('InfraService', () => {
  let service: InfraService;
  let prisma: PrismaMock;
  let assets: { create: Mock; remove: Mock; assertExists: Mock };
  let assignments: { findAll: Mock };
  let articles: { findArticlesForAsset: Mock };
  // The tx client the $transaction callback receives (RUNS_ON migration writes through it).
  let txEdge: { create: Mock; updateMany: Mock };

  beforeEach(async () => {
    txEdge = {
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    prisma = {
      infraNode: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      infraEdge: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      asset: { findFirst: jest.fn() },
      $transaction: jest.fn(
        (cb: (tx: { infraEdge: typeof txEdge }) => unknown) =>
          cb({ infraEdge: txEdge }),
      ),
    };
    assets = {
      create: jest.fn(),
      remove: jest.fn(),
      assertExists: jest.fn().mockResolvedValue(undefined),
    };
    assignments = { findAll: jest.fn().mockResolvedValue([]) };
    articles = {
      findArticlesForAsset: jest.fn().mockResolvedValue({ items: [] }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        InfraService,
        { provide: PrismaService, useValue: prisma },
        { provide: ActorService, useValue: new ActorService() },
        { provide: AssetsService, useValue: assets },
        { provide: AssetAssignmentsService, useValue: assignments },
        { provide: ArticlesService, useValue: articles },
      ],
    }).compile();
    service = moduleRef.get(InfraService);
  });

  // ── Asset linkage on create (ADR-0070 §5) ───────────────────────────────────

  describe('createNode — default-on asset linkage', () => {
    it('creates a minimal backing Asset stamped with the auto-created marker when no assetId is given', async () => {
      assets.create.mockResolvedValue({ id: 'asset-new' });
      prisma.infraNode.create.mockResolvedValue({ id: 'node-1' });

      await service.createNode({ kind: 'VM', label: 'web-01' }, true, HUMAN);

      // The reused asset-create gets ONLY the required fields + the provenance marker (ponytail).
      expect(assets.create).toHaveBeenCalledWith(
        {
          name: 'web-01',
          status: 'UNKNOWN',
          specs: { _infraAutoCreated: true },
        },
        HUMAN,
      );
      // The node is wired to the freshly-created asset.
      const arg = firstArg<{ data: { assetId?: string } }>(
        prisma.infraNode.create,
      );
      expect(arg.data.assetId).toBe('asset-new');
    });

    it('links an existing asset (asserting it exists), creating NO new asset', async () => {
      prisma.infraNode.create.mockResolvedValue({ id: 'node-1' });

      await service.createNode(
        { kind: 'VM', label: 'web-01', assetId: 'asset-existing' },
        true,
        HUMAN,
      );

      expect(assets.assertExists).toHaveBeenCalledWith('asset-existing');
      expect(assets.create).not.toHaveBeenCalled();
      const arg = firstArg<{ data: { assetId?: string } }>(
        prisma.infraNode.create,
      );
      expect(arg.data.assetId).toBe('asset-existing');
    });

    it('makes a graph-only node (no asset) when trackAsAsset is false', async () => {
      prisma.infraNode.create.mockResolvedValue({ id: 'node-1' });

      await service.createNode({ kind: 'CONTAINER', label: 'redis' }, false);

      expect(assets.create).not.toHaveBeenCalled();
      const arg = firstArg<{ data: { assetId: string | null } }>(
        prisma.infraNode.create,
      );
      // Graph-only: the link is explicitly null (no backing asset).
      expect(arg.data.assetId).toBeNull();
    });

    it('rejects passing an assetId while trackAsAsset is false (a contradiction)', async () => {
      await expect(
        service.createNode(
          { kind: 'VM', label: 'x', assetId: 'asset-1' },
          false,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.infraNode.create).not.toHaveBeenCalled();
    });
  });

  // ── Detach semantics (ADR-0070 §5) — the orphan fix ─────────────────────────

  describe('updateNode — detach (assetId: null)', () => {
    it('SOFT-DELETES an auto-created Asset on detach (it carries the provenance marker)', async () => {
      prisma.infraNode.findFirst.mockResolvedValue({
        id: 'node-1',
        assetId: 'asset-auto',
      });
      prisma.asset.findFirst.mockResolvedValue({
        specs: { _infraAutoCreated: true },
      });
      prisma.infraNode.update.mockResolvedValue({
        id: 'node-1',
        assetId: null,
      });

      await service.updateNode('node-1', { assetId: null }, HUMAN);

      // The auto-created asset is soft-deleted (reuses AssetsService.remove → DELETED event + search drop).
      expect(assets.remove).toHaveBeenCalledWith('asset-auto', HUMAN);
      // …and the node link is nulled.
      const arg = firstArg<{ data: { assetId: string | null } }>(
        prisma.infraNode.update,
      );
      expect(arg.data.assetId).toBeNull();
    });

    it('only UN-LINKS a pre-existing Asset on detach (no marker → left intact)', async () => {
      prisma.infraNode.findFirst.mockResolvedValue({
        id: 'node-1',
        assetId: 'asset-real',
      });
      prisma.asset.findFirst.mockResolvedValue({ specs: { cpu: 8 } }); // no marker
      prisma.infraNode.update.mockResolvedValue({
        id: 'node-1',
        assetId: null,
      });

      await service.updateNode('node-1', { assetId: null }, HUMAN);

      // The pre-existing asset is NOT soft-deleted — only the link is dropped.
      expect(assets.remove).not.toHaveBeenCalled();
      const arg = firstArg<{ data: { assetId: string | null } }>(
        prisma.infraNode.update,
      );
      expect(arg.data.assetId).toBeNull();
    });

    it('does not touch any asset when the update is unrelated to linkage', async () => {
      prisma.infraNode.findFirst.mockResolvedValue({
        id: 'node-1',
        assetId: 'asset-real',
      });
      prisma.infraNode.update.mockResolvedValue({ id: 'node-1' });

      await service.updateNode('node-1', { label: 'renamed' }, HUMAN);

      expect(assets.remove).not.toHaveBeenCalled();
      expect(prisma.asset.findFirst).not.toHaveBeenCalled();
    });
  });

  // ── RUNS_ON migration / active-unique (ADR-0070 §3/§4 UC-4) ─────────────────

  describe('createEdge — RUNS_ON one-active-host', () => {
    beforeEach(() => {
      // Both endpoints exist (plausible VM → host).
      prisma.infraNode.findFirst.mockImplementation(
        (args: { where: { id: string } }) =>
          Promise.resolve(
            args.where.id === 'vm-1'
              ? { id: 'vm-1', kind: 'VM' }
              : { id: 'host-1', kind: 'PHYSICAL_HOST' },
          ),
      );
    });

    it("migrates: closes the source's active RUNS_ON, then opens the new one (one transaction)", async () => {
      txEdge.create.mockResolvedValue({ id: 'edge-new' });

      await service.createEdge({
        sourceId: 'vm-1',
        targetId: 'host-1',
        kind: 'RUNS_ON',
      });

      // Close-then-open: updateMany (close the source's active RUNS_ON) THEN create (open the new one).
      const closeArg = firstArg<{
        where: { sourceId: string; kind: string; endedAt: null };
        data: { endedAt: Date };
      }>(txEdge.updateMany);
      expect(closeArg.where).toEqual({
        sourceId: 'vm-1',
        kind: 'RUNS_ON',
        endedAt: null,
      });
      expect(closeArg.data.endedAt).toBeInstanceOf(Date);
      expect(txEdge.create).toHaveBeenCalledWith({
        data: { sourceId: 'vm-1', targetId: 'host-1', kind: 'RUNS_ON' },
      });
      // The close must happen before the open (the migration ordering).
      expect(txEdge.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        txEdge.create.mock.invocationCallOrder[0],
      );
    });

    it('maps a racing active-unique P2002 to a friendly 409', async () => {
      txEdge.create.mockRejectedValue(
        new KnownError('P2002', { target: RUNS_ON_INDEX }),
      );

      await expect(
        service.createEdge({
          sourceId: 'vm-1',
          targetId: 'host-1',
          kind: 'RUNS_ON',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ── CONNECTS_TO canonicalization (ADR-0070 §3) ──────────────────────────────

  describe('createEdge — CONNECTS_TO is symmetric (canonicalize lower id as source)', () => {
    beforeEach(() => {
      prisma.infraNode.findFirst.mockImplementation(
        (args: { where: { id: string } }) =>
          Promise.resolve({ id: args.where.id, kind: 'NETWORK_DEVICE' }),
      );
    });

    it('stores the LOWER id as source regardless of input order (high → low input)', async () => {
      prisma.infraEdge.create.mockResolvedValue({ id: 'edge-1' });

      // Input source > target — must be swapped so the stored source is the lower id.
      await service.createEdge({
        sourceId: 'zzz',
        targetId: 'aaa',
        kind: 'CONNECTS_TO',
      });

      expect(prisma.infraEdge.create).toHaveBeenCalledWith({
        data: { sourceId: 'aaa', targetId: 'zzz', kind: 'CONNECTS_TO' },
      });
    });

    it('leaves an already-canonical pair untouched (low → high input)', async () => {
      prisma.infraEdge.create.mockResolvedValue({ id: 'edge-1' });

      await service.createEdge({
        sourceId: 'aaa',
        targetId: 'zzz',
        kind: 'CONNECTS_TO',
      });

      expect(prisma.infraEdge.create).toHaveBeenCalledWith({
        data: { sourceId: 'aaa', targetId: 'zzz', kind: 'CONNECTS_TO' },
      });
    });

    it('maps the canonical-pair unique P2002 to a friendly 409', async () => {
      prisma.infraEdge.create.mockRejectedValue(
        new KnownError('P2002', { target: CONNECTS_TO_INDEX }),
      );

      await expect(
        service.createEdge({
          sourceId: 'aaa',
          targetId: 'zzz',
          kind: 'CONNECTS_TO',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('createEdge — endpoint validation', () => {
    it('rejects when an endpoint is missing/archived (400)', async () => {
      prisma.infraNode.findFirst.mockResolvedValue(null);
      await expect(
        service.createEdge({
          sourceId: 'a',
          targetId: 'b',
          kind: 'DEPENDS_ON',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── Drill-in (ADR-0070 §6) — secret handles only, never values (INV-10) ─────

  describe('getNodeDetail — the payoff panel', () => {
    it('returns secretRefs as an empty array and NEVER any ciphertext/value fields (INV-10)', async () => {
      prisma.infraNode.findFirst.mockResolvedValue({
        id: 'node-1',
        label: 'web-01',
        assetId: 'asset-1',
      });
      prisma.infraEdge.findMany.mockResolvedValue([]); // no children
      prisma.asset.findFirst.mockResolvedValue({ name: 'Inventory name' });

      const detail = await service.getNodeDetail('node-1', HUMAN);

      // Handles only, none today (no asset→secret linkage exists) — and crucially NO value/cipher leak.
      expect(detail.secretRefs).toEqual([]);
      const serialized = JSON.stringify(detail);
      expect(serialized).not.toMatch(/ciphertext|authTag|"iv"|wrappedDek/i);
    });

    it('surfaces owners via the active AssetAssignment + the inventory name; label wins for display', async () => {
      prisma.infraNode.findFirst.mockResolvedValue({
        id: 'node-1',
        label: 'web-01', // canvas label
        assetId: 'asset-1',
      });
      prisma.infraEdge.findMany.mockResolvedValue([]);
      prisma.asset.findFirst.mockResolvedValue({ name: 'srv-prod-01' }); // secondary inventory name
      assignments.findAll.mockResolvedValue([
        {
          id: 'as-1',
          user: {
            id: 'u-9',
            firstName: 'Ada',
            lastName: 'Lovelace',
            email: 'ada@example.com',
            deletedAt: null,
          },
        },
      ]);

      const detail = await service.getNodeDetail('node-1', HUMAN);

      expect(detail.label).toBe('web-01'); // label is the display name
      expect(detail.assetName).toBe('srv-prod-01'); // asset.name is secondary
      expect(detail.owners).toEqual([
        {
          assignmentId: 'as-1',
          userId: 'u-9',
          firstName: 'Ada',
          lastName: 'Lovelace',
          email: 'ada@example.com',
          deletedAt: null,
        },
      ]);
      expect(assignments.findAll).toHaveBeenCalledWith({
        assetId: 'asset-1',
        activeOnly: true,
        includeUser: true,
      });
    });

    it('derives children from ACTIVE inverse RUNS_ON edges', async () => {
      prisma.infraNode.findFirst.mockResolvedValue({
        id: 'host-1',
        label: 'host',
        assetId: null, // graph-only — no owner/KB lookups
      });
      prisma.infraEdge.findMany.mockResolvedValue([
        {
          source: { id: 'vm-1', label: 'web-01', kind: 'VM', status: 'ONLINE' },
        },
      ]);

      const detail = await service.getNodeDetail('host-1');

      // Queried the inverse active RUNS_ON (targetId = me, endedAt null).
      expect(prisma.infraEdge.findMany).toHaveBeenCalledWith({
        where: { targetId: 'host-1', kind: 'RUNS_ON', endedAt: null },
        select: {
          source: {
            select: { id: true, label: true, kind: true, status: true },
          },
        },
      });
      expect(detail.children).toEqual([
        { id: 'vm-1', label: 'web-01', kind: 'VM', status: 'ONLINE' },
      ]);
      // Graph-only node: no asset → empty owners/KB, never queried.
      expect(detail.owners).toEqual([]);
      expect(detail.articleLinks).toEqual([]);
      expect(assignments.findAll).not.toHaveBeenCalled();
    });
  });

  // ── Edge close (ADR-0019 lifecycle marker) ──────────────────────────────────

  describe('closeEdge', () => {
    it('sets endedAt on an open edge', async () => {
      prisma.infraEdge.findUnique.mockResolvedValue({
        id: 'e-1',
        endedAt: null,
      });
      prisma.infraEdge.update.mockResolvedValue({
        id: 'e-1',
        endedAt: new Date(),
      });

      await service.closeEdge('e-1');

      const arg = firstArg<{ data: { endedAt: Date } }>(
        prisma.infraEdge.update,
      );
      expect(arg.data.endedAt).toBeInstanceOf(Date);
    });

    it('409s an already-closed edge', async () => {
      prisma.infraEdge.findUnique.mockResolvedValue({
        id: 'e-1',
        endedAt: new Date(),
      });
      await expect(service.closeEdge('e-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });
});
