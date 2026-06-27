import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AgentReportSchema } from '@lazyit/shared';
import { InfraService } from './infra.service';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
import { AssetsService } from '../assets/assets.service';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { ArticlesService } from '../articles/articles.service';
import { SecretManagerService } from '../secret-manager/secret-manager.service';
import { SearchService } from '../search/search.service';

// Mock the generated Prisma client so the test never loads the real one (no DB). The service uses
// `Prisma` for types (erased) AND at runtime for `Prisma.PrismaClientKnownRequestError` (the P2002
// edge-conflict mapping) and `Prisma.DbNull`, so the factory provides both (defined INSIDE the
// factory — jest.mock is hoisted, an outer reference would hit the TDZ).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {
    DbNull: { __dbNull: true },
    // `Prisma.sql` tags the recursive-CTE template (getImpact). The real helper builds a parameterized
    // query object; the test only asserts the call happened + returns mocked rows, so a passthrough
    // that captures the raw fragments + values is enough (no DB, no SQL execution).
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
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
  infraNodeSecretRef: { findMany: Mock; upsert: Mock; deleteMany: Mock };
  asset: { findFirst: Mock };
  $transaction: Mock;
  $queryRaw: Mock;
}

const HUMAN = { kind: 'human', user: { id: 'u-1' } } as never;

describe('InfraService', () => {
  let service: InfraService;
  let prisma: PrismaMock;
  let assets: { create: Mock; remove: Mock; assertExists: Mock };
  let assignments: { findAll: Mock };
  let articles: { findArticlesForAsset: Mock };
  // The node→secret linkage helpers (ADR-0073, #801): metadata-only resolve + attach authz.
  let secrets: { resolveHandlesMetadata: Mock; assertHandleAttachable: Mock };
  // The fire-and-forget search sync (ADR-0035): upsert on write, remove on soft-delete.
  let search: { upsert: Mock; remove: Mock };
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
      // Default: a node has no secret links (the existing getNodeDetail tests stay graph-clean).
      infraNodeSecretRef: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue(undefined),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      asset: { findFirst: jest.fn() },
      $transaction: jest.fn(
        (cb: (tx: { infraEdge: typeof txEdge }) => unknown) =>
          cb({ infraEdge: txEdge }),
      ),
      $queryRaw: jest.fn().mockResolvedValue([]),
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
    secrets = {
      // Default: nothing to resolve (no links) and attach authz passes — overridden per test.
      resolveHandlesMetadata: jest.fn().mockResolvedValue([]),
      assertHandleAttachable: jest.fn().mockResolvedValue(undefined),
    };
    search = { upsert: jest.fn(), remove: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        InfraService,
        { provide: PrismaService, useValue: prisma },
        { provide: ActorService, useValue: new ActorService() },
        { provide: AssetsService, useValue: assets },
        { provide: AssetAssignmentsService, useValue: assignments },
        { provide: ArticlesService, useValue: articles },
        { provide: SecretManagerService, useValue: secrets },
        { provide: SearchService, useValue: search },
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

  // ── Reporting-agent ingestion (ADR-0074 §3) ─────────────────────────────────

  describe('ingestReport', () => {
    /** A full report; tests pass it through AgentReportSchema first so they exercise the real wire shape. */
    const FULL_REPORT = AgentReportSchema.parse({
      agentVersion: '1.0.0',
      reportingSource: 'agent:abc123',
      externalId: 'machine-id-xyz',
      reportedAt: '2026-06-27T12:00:00.000Z',
      host: {
        hostname: 'web-01',
        os: { name: 'Ubuntu', version: '24.04', kernel: '6.8.0' },
        cpu: { model: 'Xeon', cores: 8 },
        memoryBytes: 34359738368,
      },
      software: [{ name: 'nginx', version: '1.27.0' }],
    });

    it('UNKNOWN key → creates a PENDING/AGENT/ONLINE node and creates NO Asset', async () => {
      prisma.infraNode.findFirst.mockResolvedValue(null); // no existing node for the dedup key
      prisma.infraNode.create.mockResolvedValue({
        id: 'node-1',
        state: 'PENDING',
      });

      const ack = await service.ingestReport(FULL_REPORT);

      // Reconciled on the dedup key over non-deleted rows.
      const findArg = firstArg<{
        where: { reportingSource: string; externalId: string };
      }>(prisma.infraNode.findFirst);
      expect(findArg.where).toEqual({
        reportingSource: 'agent:abc123',
        externalId: 'machine-id-xyz',
      });

      // The new node is a PENDING proposal: source=AGENT, state=PENDING, status=ONLINE, label=hostname.
      const createArg = firstArg<{
        data: {
          kind: string;
          label: string;
          status: string;
          source: string;
          state: string;
          reportingSource: string;
          externalId: string;
          lastReportedAt: Date;
          specs: { host: { hostname: string }; software: unknown };
        };
      }>(prisma.infraNode.create);
      expect(createArg.data.source).toBe('AGENT');
      expect(createArg.data.state).toBe('PENDING');
      expect(createArg.data.status).toBe('ONLINE');
      expect(createArg.data.kind).toBe('PHYSICAL_HOST');
      expect(createArg.data.label).toBe('web-01');
      expect(createArg.data.reportingSource).toBe('agent:abc123');
      expect(createArg.data.externalId).toBe('machine-id-xyz');
      expect(createArg.data.lastReportedAt).toBeInstanceOf(Date);
      // The inventory blob is carried into specs (host + software under clear keys).
      expect(createArg.data.specs.host.hostname).toBe('web-01');
      expect(createArg.data.specs.software).toEqual([
        { name: 'nginx', version: '1.27.0' },
      ]);

      // A PENDING node is a PROPOSAL — NO backing Asset is created until a human confirms.
      expect(assets.create).not.toHaveBeenCalled();
      expect(prisma.infraNode.update).not.toHaveBeenCalled();

      expect(ack).toEqual({
        nodeId: 'node-1',
        state: 'PENDING',
        accepted: true,
      });
    });

    it('KNOWN key → updates specs + lastReportedAt + status, NEVER touching state/label (human curation)', async () => {
      // A human has already CONFIRMED + renamed this node; the agent must not clobber that.
      prisma.infraNode.findFirst.mockResolvedValue({ id: 'node-1' });
      prisma.infraNode.update.mockResolvedValue({
        id: 'node-1',
        state: 'CONFIRMED',
      });

      const ack = await service.ingestReport(FULL_REPORT);

      const updateArg = firstArg<{
        where: { id: string };
        data: Record<string, unknown>;
      }>(prisma.infraNode.update);
      expect(updateArg.where).toEqual({ id: 'node-1' });
      // Only inventory facts + liveness are written…
      expect(updateArg.data.status).toBe('ONLINE');
      expect(updateArg.data.lastReportedAt).toBeInstanceOf(Date);
      expect(updateArg.data.specs).toBeDefined();
      // …NEVER the human's curation (state/label/position/asset link).
      expect(updateArg.data).not.toHaveProperty('state');
      expect(updateArg.data).not.toHaveProperty('label');
      expect(updateArg.data).not.toHaveProperty('x');
      expect(updateArg.data).not.toHaveProperty('y');
      expect(updateArg.data).not.toHaveProperty('assetId');
      expect(updateArg.data).not.toHaveProperty('source');

      // No new node + no Asset on an update.
      expect(prisma.infraNode.create).not.toHaveBeenCalled();
      expect(assets.create).not.toHaveBeenCalled();

      // The ack echoes the node's existing (human-owned) state untouched.
      expect(ack).toEqual({
        nodeId: 'node-1',
        state: 'CONFIRMED',
        accepted: true,
      });
    });

    it('a PARTIAL report (only the dedup keys + hostname) validates and ingests', async () => {
      // The agent degrades gracefully (no privilege / missing tools): everything but the keys + hostname
      // is omitted. This MUST pass AgentReportSchema (never a 400) and still create a node (ADR-0074 §2).
      const partial = AgentReportSchema.parse({
        agentVersion: '1.0.0',
        reportingSource: 'agent:minimal',
        externalId: 'machine-min',
        reportedAt: '2026-06-27T12:00:00.000Z',
        host: { hostname: 'tiny-01' },
      });

      prisma.infraNode.findFirst.mockResolvedValue(null);
      prisma.infraNode.create.mockResolvedValue({
        id: 'node-2',
        state: 'PENDING',
      });

      const ack = await service.ingestReport(partial);

      const createArg = firstArg<{
        data: { label: string; specs: { software?: unknown } };
      }>(prisma.infraNode.create);
      expect(createArg.data.label).toBe('tiny-01');
      // `software` was omitted from the report → it is NOT written into specs (no empty key).
      expect(createArg.data.specs.software).toBeUndefined();
      expect(ack).toEqual({
        nodeId: 'node-2',
        state: 'PENDING',
        accepted: true,
      });
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
    it('resolves linked secret HANDLES to metadata, DROPS dangling refs, and NEVER leaks ciphertext (INV-10, ADR-0073)', async () => {
      prisma.infraNode.findFirst.mockResolvedValue({
        id: 'node-1',
        label: 'web-01',
        assetId: 'asset-1',
      });
      prisma.infraEdge.findMany.mockResolvedValue([]); // no children
      prisma.asset.findFirst.mockResolvedValue({ name: 'Inventory name' });
      // The node has TWO soft links, but one is dangling (its secret was soft-deleted / renamed away).
      prisma.infraNodeSecretRef.findMany.mockResolvedValue([
        { handle: 'db_root', vaultId: 'v-1' },
        { handle: 'gone', vaultId: 'v-1' }, // no longer a live secret → dropped by the resolver
      ]);
      // The resolver returns ONLY the live one — metadata only (handle/label/vaultId), no value fields.
      secrets.resolveHandlesMetadata.mockResolvedValue([
        { handle: 'db_root', label: 'DB root', vaultId: 'v-1' },
      ]);

      const detail = await service.getNodeDetail('node-1', HUMAN);

      // The links are handed to the metadata-only resolver…
      expect(secrets.resolveHandlesMetadata).toHaveBeenCalledWith([
        { handle: 'db_root', vaultId: 'v-1' },
        { handle: 'gone', vaultId: 'v-1' },
      ]);
      // …and only the live ref surfaces (the dangling one is dropped).
      expect(detail.secretRefs).toEqual([
        { handle: 'db_root', label: 'DB root', vaultId: 'v-1' },
      ]);
      // Crucially, NO value/cipher leak anywhere in the payload.
      const serialized = JSON.stringify(detail);
      expect(serialized).not.toMatch(/ciphertext|authTag|"iv"|wrappedDek/i);
    });

    it('returns empty secretRefs without calling the resolver when the node has no links', async () => {
      prisma.infraNode.findFirst.mockResolvedValue({
        id: 'node-1',
        label: 'web-01',
        assetId: null,
      });
      prisma.infraEdge.findMany.mockResolvedValue([]);
      // infraNodeSecretRef.findMany defaults to [] — no links.

      const detail = await service.getNodeDetail('node-1', HUMAN);

      expect(detail.secretRefs).toEqual([]);
      // No links → the resolver is never invoked (ponytail: skip the round-trip).
      expect(secrets.resolveHandlesMetadata).not.toHaveBeenCalled();
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

  // ── Node → secret linkage (ADR-0073, #801) ──────────────────────────────────

  describe('attachSecret', () => {
    const DTO = { handle: 'db_root', vaultId: 'v-1' };

    it('404s when the node is missing or soft-deleted (getNode guard)', async () => {
      prisma.infraNode.findFirst.mockResolvedValue(null);

      await expect(
        service.attachSecret('nope', DTO, HUMAN),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Never reaches authz or the write.
      expect(secrets.assertHandleAttachable).not.toHaveBeenCalled();
      expect(prisma.infraNodeSecretRef.upsert).not.toHaveBeenCalled();
    });

    it('is FORBIDDEN when the caller is NOT a live member of the vault (no write happens)', async () => {
      prisma.infraNode.findFirst.mockResolvedValue({ id: 'node-1' });
      secrets.assertHandleAttachable.mockRejectedValue(
        new ForbiddenException('not a member'),
      );

      await expect(
        service.attachSecret('node-1', DTO, HUMAN),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Authz is enforced via the Secret Manager BEFORE the join row is written.
      expect(secrets.assertHandleAttachable).toHaveBeenCalledWith(
        HUMAN,
        'v-1',
        'db_root',
      );
      expect(prisma.infraNodeSecretRef.upsert).not.toHaveBeenCalled();
    });

    it('upserts idempotently on the (node, vault, handle) unique and returns the resolved refs (never an envelope)', async () => {
      prisma.infraNode.findFirst.mockResolvedValue({ id: 'node-1' });
      prisma.infraNodeSecretRef.findMany.mockResolvedValue([
        { handle: 'db_root', vaultId: 'v-1' },
      ]);
      secrets.resolveHandlesMetadata.mockResolvedValue([
        { handle: 'db_root', label: 'DB root', vaultId: 'v-1' },
      ]);

      const refs = await service.attachSecret('node-1', DTO, HUMAN);

      // Idempotent upsert: re-attaching is a no-op (update {}), NOT a 409.
      expect(prisma.infraNodeSecretRef.upsert).toHaveBeenCalledWith({
        where: {
          nodeId_vaultId_handle: {
            nodeId: 'node-1',
            vaultId: 'v-1',
            handle: 'db_root',
          },
        },
        create: { nodeId: 'node-1', vaultId: 'v-1', handle: 'db_root' },
        update: {},
      });
      // Returns the node's UPDATED resolved secretRefs — metadata only.
      expect(refs).toEqual([
        { handle: 'db_root', label: 'DB root', vaultId: 'v-1' },
      ]);
      expect(JSON.stringify(refs)).not.toMatch(
        /ciphertext|authTag|"iv"|wrappedDek/i,
      );
    });
  });

  describe('detachSecret', () => {
    const DTO = { handle: 'db_root', vaultId: 'v-1' };

    it('404s when the node is missing or soft-deleted (getNode guard)', async () => {
      prisma.infraNode.findFirst.mockResolvedValue(null);

      await expect(service.detachSecret('nope', DTO)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.infraNodeSecretRef.deleteMany).not.toHaveBeenCalled();
    });

    it('hard-deletes the matching ref (idempotent — no membership needed) and returns the updated refs', async () => {
      prisma.infraNode.findFirst.mockResolvedValue({ id: 'node-1' });
      // After the delete, no links remain.
      prisma.infraNodeSecretRef.findMany.mockResolvedValue([]);

      const refs = await service.detachSecret('node-1', DTO);

      expect(prisma.infraNodeSecretRef.deleteMany).toHaveBeenCalledWith({
        where: { nodeId: 'node-1', vaultId: 'v-1', handle: 'db_root' },
      });
      // Detach is a topology edit — it never calls the Secret Manager authz.
      expect(secrets.assertHandleAttachable).not.toHaveBeenCalled();
      expect(refs).toEqual([]);
    });

    it('is idempotent: detaching a ref that does not exist is a no-op (deleteMany count 0)', async () => {
      prisma.infraNode.findFirst.mockResolvedValue({ id: 'node-1' });
      prisma.infraNodeSecretRef.deleteMany.mockResolvedValue({ count: 0 });
      prisma.infraNodeSecretRef.findMany.mockResolvedValue([]);

      await expect(service.detachSecret('node-1', DTO)).resolves.toEqual([]);
    });
  });

  // ── listNodes — the Servers-list enrichment (ADR-0070 §6, #750) ─────────────

  describe('listNodes — asset name + owners enrichment', () => {
    it('flattens assetName + owners from ONE include (no N+1), via the active assignments + user', async () => {
      prisma.infraNode.findMany.mockResolvedValue([
        {
          id: 'node-1',
          label: 'web-01',
          assetId: 'asset-1',
          asset: {
            name: 'srv-prod-01',
            deletedAt: null,
            assignments: [
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
            ],
          },
        },
      ]);

      const rows = await service.listNodes();

      // The enrichment came from ONE query — a relation include, NOT a per-row detail fetch.
      expect(assignments.findAll).not.toHaveBeenCalled();
      expect(prisma.infraNode.findMany).toHaveBeenCalledTimes(1);
      const arg = firstArg<{ include?: { asset?: { select?: unknown } } }>(
        prisma.infraNode.findMany,
      );
      expect(arg.include?.asset?.select).toBeDefined();

      expect(rows).toHaveLength(1);
      expect(rows[0].assetName).toBe('srv-prod-01');
      expect(rows[0].owners).toEqual([
        {
          assignmentId: 'as-1',
          userId: 'u-9',
          firstName: 'Ada',
          lastName: 'Lovelace',
          email: 'ada@example.com',
          deletedAt: null,
        },
      ]);
      // The flattened row must NOT carry the raw relation object.
      expect((rows[0] as unknown as { asset?: unknown }).asset).toBeUndefined();
    });

    it('does NOT leak a soft-deleted asset name (deletedAt set → assetName null), keeping the node', async () => {
      // The soft-delete extension only filters the TOP-LEVEL findMany, not the nested asset include —
      // a soft-deleted asset still arrives through the relation, so the name MUST be gated in app code.
      prisma.infraNode.findMany.mockResolvedValue([
        {
          id: 'node-1',
          label: 'web-01',
          assetId: 'asset-archived',
          asset: {
            name: 'should-not-leak',
            deletedAt: new Date('2026-01-01T00:00:00.000Z'),
            assignments: [],
          },
        },
      ]);

      const rows = await service.listNodes();

      expect(rows).toHaveLength(1); // the NODE still surfaces…
      expect(rows[0].assetName).toBeNull(); // …but the archived asset's name is withheld.
    });

    it('returns null assetName + empty owners for a graph-only node (no linked asset)', async () => {
      prisma.infraNode.findMany.mockResolvedValue([
        { id: 'node-1', label: 'redis', assetId: null, asset: null },
      ]);

      const rows = await service.listNodes();

      expect(rows[0].assetName).toBeNull();
      expect(rows[0].owners).toEqual([]);
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

  // ── Fire-and-forget search sync (ADR-0035 / ADR-0070 v1, #740) ──────────────

  describe('search sync', () => {
    it('upserts the node (with linked asset name) into the infra index on create', async () => {
      prisma.infraNode.create.mockResolvedValue({ id: 'node-1' });
      // The post-write re-read the sync helper does (node + joined asset name).
      prisma.infraNode.findFirst.mockResolvedValue({
        id: 'node-1',
        label: 'web-01',
        kind: 'VM',
        status: 'ONLINE',
        state: 'CONFIRMED',
        ipAddress: '10.0.0.5',
        asset: { name: 'srv-prod-01' },
      });

      await service.createNode({ kind: 'VM', label: 'web-01' }, false);
      // The sync is fire-and-forget (un-awaited inside the service); let the microtask drain.
      await Promise.resolve();
      await Promise.resolve();

      expect(search.upsert).toHaveBeenCalledWith('infra', {
        id: 'node-1',
        label: 'web-01',
        kind: 'VM',
        status: 'ONLINE',
        state: 'CONFIRMED',
        ipAddress: '10.0.0.5',
        assetName: 'srv-prod-01', // the linked asset name is joined in (NEVER a secret value)
      });
    });

    it('removes the node from the infra index on soft-delete', async () => {
      prisma.infraNode.findFirst.mockResolvedValue({ id: 'node-1' });
      prisma.infraNode.update.mockResolvedValue({ id: 'node-1' });

      await service.removeNode('node-1');

      expect(search.remove).toHaveBeenCalledWith('infra', 'node-1');
      expect(search.upsert).not.toHaveBeenCalled();
    });

    it('re-indexes the node on restore', async () => {
      prisma.infraNode.findFirst
        .mockResolvedValueOnce({ id: 'node-1', deletedAt: new Date() }) // restore lookup
        .mockResolvedValueOnce({
          id: 'node-1',
          label: 'redis',
          kind: 'CONTAINER',
          status: 'UNKNOWN',
          state: 'CONFIRMED',
          ipAddress: null,
          asset: null, // graph-only — assetName is null, not a leaked value
        });
      prisma.infraNode.update.mockResolvedValue({ id: 'node-1' });

      await service.restoreNode('node-1');
      await Promise.resolve();
      await Promise.resolve();

      expect(search.upsert).toHaveBeenCalledWith('infra', {
        id: 'node-1',
        label: 'redis',
        kind: 'CONTAINER',
        status: 'UNKNOWN',
        state: 'CONFIRMED',
        ipAddress: null,
        assetName: null,
      });
    });
  });

  // ── Impact / blast-radius (ADR-0070 §7, #739) ───────────────────────────────
  //
  // The traversal itself is ONE Postgres recursive CTE (no per-level Prisma calls); a Jest run has no
  // DB, so we drive `$queryRaw` with an in-memory simulation of the EXACT semantics the CTE must
  // satisfy — walk the INVERSE of ACTIVE RUNS_ON/DEPENDS_ON/MEMBER_OF edges from the root, skip soft-deleted
  // nodes, dedup to the MIN depth per node, and TERMINATE on a cycle (path guard). This locks the
  // contract: feed the service the rows the CTE would produce for a fixture graph and assert the
  // mapped { rootId, affected } downstream set — and that a cycle does not hang the simulation.

  describe('getImpact', () => {
    // Fixture: host(0) ← VM(1) ← container(2) RUNS_ON chain, a DEPENDS_ON branch app(1) → host, and a
    // CYCLE container↔VM (a second RUNS_ON the other way). Edges: source RUNS_ON/DEPENDS_ON target.
    interface FixtureNode {
      id: string;
      label: string;
      kind: string;
      status: string;
      deleted?: boolean;
    }
    interface FixtureEdge {
      sourceId: string;
      targetId: string;
      kind: string;
      active: boolean;
    }

    /** In-memory analogue of the recursive CTE: inverse traversal, cycle-safe, MIN depth per node. */
    function simulateImpact(
      rootId: string,
      nodes: FixtureNode[],
      edges: FixtureEdge[],
    ): Array<{
      id: string;
      label: string;
      kind: string;
      status: string;
      depth: number;
    }> {
      const liveById = new Map(
        nodes.filter((n) => !n.deleted).map((n) => [n.id, n]),
      );
      const minDepth = new Map<string, number>();
      // BFS frontier with the visited-path guard (the CTE's `path || sourceId` + NOT ANY(path)).
      const queue: Array<{ id: string; depth: number; path: Set<string> }> = [
        { id: rootId, depth: 0, path: new Set([rootId]) },
      ];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (cur.depth >= 64) continue; // mirrors IMPACT_MAX_DEPTH
        for (const e of edges) {
          if (!e.active) continue;
          // Mirrors the service's traversal kinds (#802): MEMBER_OF included, BACKS_UP_TO/CONNECTS_TO not.
          if (
            e.kind !== 'RUNS_ON' &&
            e.kind !== 'DEPENDS_ON' &&
            e.kind !== 'MEMBER_OF'
          )
            continue;
          if (e.targetId !== cur.id) continue; // INVERSE: source depends-on/runs-on the frontier
          const src = e.sourceId;
          if (!liveById.has(src)) continue; // skip soft-deleted
          if (cur.path.has(src)) continue; // CYCLE GUARD — already on the path, do not recurse
          const depth = cur.depth + 1;
          const prev = minDepth.get(src);
          if (prev === undefined || depth < prev) minDepth.set(src, depth);
          queue.push({ id: src, depth, path: new Set(cur.path).add(src) });
        }
      }
      return [...minDepth.entries()]
        .map(([id, depth]) => {
          const n = liveById.get(id)!;
          return { id, label: n.label, kind: n.kind, status: n.status, depth };
        })
        .sort((a, b) => a.depth - b.depth || a.label.localeCompare(b.label));
    }

    const NODES: FixtureNode[] = [
      { id: 'host', label: 'host', kind: 'PHYSICAL_HOST', status: 'ONLINE' },
      { id: 'vm', label: 'vm', kind: 'VM', status: 'ONLINE' },
      {
        id: 'container',
        label: 'container',
        kind: 'CONTAINER',
        status: 'ONLINE',
      },
      { id: 'app', label: 'app', kind: 'OTHER', status: 'ONLINE' },
      {
        id: 'ghost',
        label: 'ghost',
        kind: 'VM',
        status: 'OFFLINE',
        deleted: true,
      },
      // A separate cluster subgraph (#802): two members via MEMBER_OF, plus a BACKS_UP_TO/CONNECTS_TO
      // neighbour that must NOT contribute. Disjoint from `host`, so the chain tests above are unaffected.
      { id: 'cluster', label: 'cluster', kind: 'CLUSTER', status: 'ONLINE' },
      {
        id: 'member-a',
        label: 'member-a',
        kind: 'PHYSICAL_HOST',
        status: 'ONLINE',
      },
      {
        id: 'member-b',
        label: 'member-b',
        kind: 'PHYSICAL_HOST',
        status: 'ONLINE',
      },
      {
        id: 'primary',
        label: 'primary',
        kind: 'PHYSICAL_HOST',
        status: 'ONLINE',
      },
      { id: 'peer', label: 'peer', kind: 'PHYSICAL_HOST', status: 'ONLINE' },
    ];
    const EDGES: FixtureEdge[] = [
      { sourceId: 'vm', targetId: 'host', kind: 'RUNS_ON', active: true }, // vm RUNS_ON host
      { sourceId: 'container', targetId: 'vm', kind: 'RUNS_ON', active: true }, // container RUNS_ON vm
      { sourceId: 'app', targetId: 'host', kind: 'DEPENDS_ON', active: true }, // app DEPENDS_ON host
      { sourceId: 'vm', targetId: 'container', kind: 'RUNS_ON', active: true }, // CYCLE: vm↔container
      { sourceId: 'ghost', targetId: 'host', kind: 'RUNS_ON', active: true }, // soft-deleted → excluded
      { sourceId: 'vm', targetId: 'host', kind: 'CONNECTS_TO', active: true }, // wrong kind → ignored
      // Cluster subgraph (#802): members belong to the cluster (member=source, cluster=target).
      {
        sourceId: 'member-a',
        targetId: 'cluster',
        kind: 'MEMBER_OF',
        active: true,
      }, // surfaces (cluster down)
      {
        sourceId: 'member-b',
        targetId: 'cluster',
        kind: 'MEMBER_OF',
        active: true,
      }, // surfaces (cluster down)
      {
        sourceId: 'primary',
        targetId: 'cluster',
        kind: 'BACKS_UP_TO',
        active: true,
      }, // excluded: backup target
      {
        sourceId: 'peer',
        targetId: 'cluster',
        kind: 'CONNECTS_TO',
        active: true,
      }, // excluded: symmetric
    ];

    function wireQueryRaw(rootId: string): void {
      prisma.infraNode.findFirst.mockResolvedValue({ id: rootId }); // getNode (root exists, live)
      prisma.$queryRaw.mockResolvedValue(simulateImpact(rootId, NODES, EDGES));
    }

    it('returns the transitive downstream set with MIN depth per node (chain + DEPENDS_ON branch)', async () => {
      wireQueryRaw('host');

      const result = await service.getImpact('host');

      expect(result.rootId).toBe('host');
      // host goes down → vm (RUNS_ON, depth 1), app (DEPENDS_ON, depth 1), container (via vm, depth 2).
      expect(result.affected).toEqual([
        { id: 'app', label: 'app', kind: 'OTHER', status: 'ONLINE', depth: 1 },
        { id: 'vm', label: 'vm', kind: 'VM', status: 'ONLINE', depth: 1 },
        {
          id: 'container',
          label: 'container',
          kind: 'CONTAINER',
          status: 'ONLINE',
          depth: 2,
        },
      ]);
      // The root itself is never in the affected set; the soft-deleted 'ghost' is excluded.
      const ids = result.affected.map((a) => a.id);
      expect(ids).not.toContain('host');
      expect(ids).not.toContain('ghost');
    });

    it('is cycle-safe: the vm↔container cycle terminates and each node appears once', async () => {
      wireQueryRaw('host');

      const result = await service.getImpact('host');

      // Despite vm→container→vm being a cycle, every node appears exactly once (path guard + MIN depth).
      const ids = result.affected.map((a) => a.id).sort();
      expect(ids).toEqual(['app', 'container', 'vm']);
      expect(new Set(ids).size).toBe(ids.length); // no duplicates — the cycle did not re-emit nodes
    });

    it('surfaces MEMBER_OF members when a cluster goes down, but not BACKS_UP_TO/CONNECTS_TO neighbours (#802)', async () => {
      wireQueryRaw('cluster');

      const result = await service.getImpact('cluster');

      expect(result.rootId).toBe('cluster');
      const ids = result.affected.map((a) => a.id).sort();
      // The two members (MEMBER_OF) surface at depth 1; the backup primary and the network peer do not.
      expect(ids).toEqual(['member-a', 'member-b']);
      expect(ids).not.toContain('primary'); // BACKS_UP_TO: a backup target down doesn't take the primary down
      expect(ids).not.toContain('peer'); // CONNECTS_TO: symmetric — no failure direction
      for (const a of result.affected) expect(a.depth).toBe(1);
    });

    it('404s when the root node is missing or soft-deleted (getNode guard)', async () => {
      prisma.infraNode.findFirst.mockResolvedValue(null);
      await expect(service.getImpact('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });
});
