import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { AgentReportSchema, InfraNodeListItemSchema } from '@lazyit/shared';
import { InfraService } from './infra.service';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
import { AssetsService } from '../assets/assets.service';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { ArticlesService } from '../articles/articles.service';
import { SecretManagerService } from '../secret-manager/secret-manager.service';
import { SearchService } from '../search/search.service';
import { InfraNodeEnrollmentLimiter } from './infra-node-enrollment.limiter';
import { NotificationsService } from '../notifications/notifications.service';

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
  infraNode: {
    findFirst: Mock;
    findMany: Mock;
    create: Mock;
    update: Mock;
    updateMany: Mock;
  };
  infraEdge: {
    findFirst: Mock;
    findMany: Mock;
    findUnique: Mock;
    create: Mock;
    update: Mock;
    updateMany: Mock;
  };
  infraNodeSecretRef: { findMany: Mock; upsert: Mock; deleteMany: Mock };
  asset: { findFirst: Mock; update: Mock };
  $transaction: Mock;
  $queryRaw: Mock;
}

const HUMAN = { kind: 'human', user: { id: 'u-1' } } as never;
/** The reporting agent's authenticated service principal (ADR-0048) — the #1134 enrollment key. */
const AGENT_SA = {
  kind: 'service',
  serviceAccount: { id: 'sa-agent' },
  permissions: new Set(['infra:report']),
} as never;

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
  // The #1134 new-node enrollment throttle. Its own rate behaviour is covered in
  // `infra-node-enrollment.limiter.spec.ts`; here we only assert the service CHARGES it on exactly
  // the branch that grows the table, and never on the branch that does not.
  let enrollment: { assertWithinBudget: Mock; tryCharge: Mock };
  // The ONE automatic action the #1141 clone detection takes — a broadcast bell nudge. Everything
  // else it does is a human action, so this mock is also how the tests assert the SILENCE.
  let notifications: { emit: Mock };
  // The tx client the $transaction callback receives (RUNS_ON migration + the #1141 merge write
  // through it — the merge needs both writes in one transaction or the dedup index refuses them).
  let txEdge: { create: Mock; updateMany: Mock };
  let txNode: { update: Mock };

  beforeEach(async () => {
    txEdge = {
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    txNode = { update: jest.fn().mockResolvedValue({ id: 'node-keep' }) };
    prisma = {
      infraNode: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
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
      asset: { findFirst: jest.fn(), update: jest.fn() },
      $transaction: jest.fn(
        (
          cb: (tx: {
            infraEdge: typeof txEdge;
            infraNode: typeof txNode;
          }) => unknown,
        ) => cb({ infraEdge: txEdge, infraNode: txNode }),
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
    // Default: within budget, so every pre-existing ingest test keeps exercising the normal path.
    enrollment = {
      assertWithinBudget: jest.fn(),
      tryCharge: jest.fn().mockReturnValue(true),
    };
    // `emit` is idempotent on its dedupeKey and never throws — the real one returns the row id or null.
    notifications = { emit: jest.fn().mockResolvedValue(null) };

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
        { provide: InfraNodeEnrollmentLimiter, useValue: enrollment },
        { provide: NotificationsService, useValue: notifications },
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
          agentVersion: string;
          specs: {
            host: { hostname: string };
            software: unknown;
            agentVersion?: unknown;
          };
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
      // The agent's build version lands in its own column (#907), NOT duplicated inside specs.
      expect(createArg.data.agentVersion).toBe('1.0.0');
      expect(createArg.data.specs).not.toHaveProperty('agentVersion');
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
      expect(updateArg.data.agentVersion).toBe('1.0.0'); // refreshed on every check-in (#907)
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

    it('RACE: a concurrent same-host report (create → P2002) falls back to the update path, never a 409 (#1012)', async () => {
      // TOCTOU: our findFirst missed (the row didn't exist yet), then a concurrent report from the SAME
      // host inserted it → our create hits the partial-unique dedup index and throws P2002. The loser
      // must re-resolve the now-existing row and take the curation-preserving update path (idempotent
      // ack), NOT surface the 409.
      prisma.infraNode.findFirst
        .mockResolvedValueOnce(null) // the initial reconcile miss (row not yet inserted)
        .mockResolvedValueOnce({ id: 'node-raced' }); // the post-P2002 re-resolve (the winner's row)
      prisma.infraNode.create.mockRejectedValueOnce(new KnownError('P2002'));
      prisma.infraNode.update.mockResolvedValue({
        id: 'node-raced',
        state: 'PENDING',
      });

      const ack = await service.ingestReport(FULL_REPORT);

      // It fell back to the SAME facts-only update (no state/label/curation touched — see the KNOWN test).
      const updateArg = firstArg<{
        where: { id: string };
        data: Record<string, unknown>;
      }>(prisma.infraNode.update);
      expect(updateArg.where).toEqual({ id: 'node-raced' });
      expect(updateArg.data.status).toBe('ONLINE');
      expect(updateArg.data).not.toHaveProperty('state');
      expect(updateArg.data).not.toHaveProperty('label');

      // Idempotent success — the loser acks instead of throwing.
      expect(ack).toEqual({
        nodeId: 'node-raced',
        state: 'PENDING',
        accepted: true,
      });
    });

    it('RACE: a P2002 whose row cannot be re-resolved rethrows the original error (no invented loop)', async () => {
      // Defensive: if the racing row is unresolvable (e.g. soft-deleted in the same instant), the fix
      // deliberately rethrows rather than looping — surfacing the real error over inventing recovery.
      prisma.infraNode.findFirst
        .mockResolvedValueOnce(null) // initial miss
        .mockResolvedValueOnce(null); // re-resolve also misses
      const raced = new KnownError('P2002');
      prisma.infraNode.create.mockRejectedValueOnce(raced);

      await expect(service.ingestReport(FULL_REPORT)).rejects.toBe(raced);
      expect(prisma.infraNode.update).not.toHaveBeenCalled();
    });

    // ── IP fact-promotion (#1081) ─────────────────────────────────────────────

    /** A report whose host advertises NICs, so a primary IPv4 can be promoted. */
    const REPORT_WITH_NICS = AgentReportSchema.parse({
      agentVersion: '1.0.0',
      reportingSource: 'agent:nic',
      externalId: 'machine-nic',
      reportedAt: '2026-06-27T12:00:00.000Z',
      host: {
        hostname: 'web-01',
        nics: [
          { name: 'lo', ipv4: ['127.0.0.1'] },
          { name: 'eth0', ipv4: ['10.0.0.12', '10.0.0.13'] },
        ],
      },
    });

    it('CREATE (unknown key) seeds ipAddress from the report (source=AGENT)', async () => {
      prisma.infraNode.findFirst.mockResolvedValue(null);
      prisma.infraNode.create.mockResolvedValue({
        id: 'node-1',
        state: 'PENDING',
      });

      await service.ingestReport(REPORT_WITH_NICS);

      const createArg = firstArg<{
        data: { ipAddress?: string; ipAddressSource?: string };
      }>(prisma.infraNode.create);
      // The first non-loopback NIC's first IPv4 becomes the node's IP, marked agent-owned.
      expect(createArg.data.ipAddress).toBe('10.0.0.12');
      expect(createArg.data.ipAddressSource).toBe('AGENT');
    });

    it('a repeat report OVERWRITES ipAddress when the node is AGENT-owned', async () => {
      prisma.infraNode.findFirst.mockResolvedValue({
        id: 'node-1',
        assetId: null,
        ipAddressSource: 'AGENT',
      });
      prisma.infraNode.update.mockResolvedValue({
        id: 'node-1',
        state: 'CONFIRMED',
      });

      await service.ingestReport(REPORT_WITH_NICS);

      const updateArg = firstArg<{ data: { ipAddress?: string } }>(
        prisma.infraNode.update,
      );
      expect(updateArg.data.ipAddress).toBe('10.0.0.12');
    });

    it('a repeat report NEVER clobbers a human-curated (MANUAL) ipAddress', async () => {
      prisma.infraNode.findFirst.mockResolvedValue({
        id: 'node-1',
        assetId: null,
        ipAddressSource: 'MANUAL',
      });
      prisma.infraNode.update.mockResolvedValue({
        id: 'node-1',
        state: 'CONFIRMED',
      });

      await service.ingestReport(REPORT_WITH_NICS);

      const updateArg = firstArg<{ data: Record<string, unknown> }>(
        prisma.infraNode.update,
      );
      // Facts + liveness still refresh, but the human's IP is left untouched.
      expect(updateArg.data.status).toBe('ONLINE');
      expect(updateArg.data).not.toHaveProperty('ipAddress');
    });

    it('a report with no IPv4 leaves an existing AGENT ipAddress intact (never nulls it)', async () => {
      prisma.infraNode.findFirst.mockResolvedValue({
        id: 'node-1',
        assetId: null,
        ipAddressSource: 'AGENT',
      });
      prisma.infraNode.update.mockResolvedValue({
        id: 'node-1',
        state: 'PENDING',
      });

      // FULL_REPORT carries no nics → primaryIpv4 is undefined → no ipAddress write.
      await service.ingestReport(FULL_REPORT);

      const updateArg = firstArg<{ data: Record<string, unknown> }>(
        prisma.infraNode.update,
      );
      expect(updateArg.data).not.toHaveProperty('ipAddress');
    });

    it('a repeat report on an ASSET-BACKED node refreshes the linked Asset.specs (host facts only)', async () => {
      prisma.infraNode.findFirst.mockResolvedValue({
        id: 'node-1',
        assetId: 'asset-1',
        ipAddressSource: 'AGENT',
      });
      prisma.infraNode.update.mockResolvedValue({
        id: 'node-1',
        state: 'CONFIRMED',
      });
      // The asset already holds a human custom field + the auto-created marker + a STALE host.
      prisma.asset.findFirst.mockResolvedValue({
        specs: {
          _infraAutoCreated: true,
          rack: 'A3',
          host: { hostname: 'OLD' },
          reportedAt: '2020-01-01T00:00:00.000Z',
        },
      });

      await service.ingestReport(FULL_REPORT);

      const updateArg = firstArg<{
        where: { id: string };
        data: { specs: Record<string, unknown> };
      }>(prisma.asset.update);
      expect(updateArg.where).toEqual({ id: 'asset-1' });
      // Agent-owned keys refreshed to the new report…
      expect((updateArg.data.specs.host as { hostname: string }).hostname).toBe(
        'web-01',
      );
      expect(updateArg.data.specs.reportedAt).toBe('2026-06-27T12:00:00.000Z');
      // …human-added keys + the provenance marker preserved.
      expect(updateArg.data.specs.rack).toBe('A3');
      expect(updateArg.data.specs._infraAutoCreated).toBe(true);
    });

    it('a soft-deleted linked Asset is skipped on the specs refresh (no asset.update)', async () => {
      prisma.infraNode.findFirst.mockResolvedValue({
        id: 'node-1',
        assetId: 'asset-gone',
        ipAddressSource: 'AGENT',
      });
      prisma.infraNode.update.mockResolvedValue({
        id: 'node-1',
        state: 'CONFIRMED',
      });
      prisma.asset.findFirst.mockResolvedValue(null); // the soft-delete extension scopes findFirst

      await service.ingestReport(FULL_REPORT);

      expect(prisma.asset.update).not.toHaveBeenCalled();
    });

    // ── Contract v2 tolerance + skew recording (#1138) ────────────────────────

    describe('agent report contract v2 (#1138)', () => {
      /** A report exactly as a PRE-v2 agent emits it — no os.family, no v2 field anywhere. */
      const V1_BODY = {
        agentVersion: '1.0.0',
        reportingSource: 'agent:legacy',
        externalId: 'machine-legacy',
        reportedAt: '2026-07-31T12:00:00.000Z',
        host: {
          hostname: 'web-03',
          os: { name: 'Ubuntu', version: '24.04', kernel: '6.8.0' },
          nics: [{ name: 'eth0', ipv4: ['10.0.0.12'] }],
        },
        software: [{ name: 'nginx', version: '1.27.0' }],
      };

      const ORIGINAL_APP_VERSION = process.env.APP_VERSION;
      afterEach(() => {
        if (ORIGINAL_APP_VERSION === undefined) delete process.env.APP_VERSION;
        else process.env.APP_VERSION = ORIGINAL_APP_VERSION;
      });

      it('a PRE-v2 report from an un-upgraded agent still ingests, unchanged', async () => {
        // The load-bearing upgrade promise: an operator upgrades the INSTANCE while every agent in the
        // estate keeps running the binary it was installed with. That report must still land, with the
        // same facts, on the same node — anything else silently empties the map.
        prisma.infraNode.findFirst.mockResolvedValue(null);
        prisma.infraNode.create.mockResolvedValue({
          id: 'node-legacy',
          state: 'PENDING',
        });

        const ack = await service.ingestReport(
          AgentReportSchema.parse(V1_BODY),
        );

        const createArg = firstArg<{
          data: {
            label: string;
            ipAddress?: string;
            specs: Record<string, unknown>;
          };
        }>(prisma.infraNode.create);
        expect(createArg.data.label).toBe('web-03');
        expect(createArg.data.ipAddress).toBe('10.0.0.12');
        // The blob is the v1 facts plus the ONE documented server-side default (os.family=linux).
        expect(createArg.data.specs).toEqual({
          host: {
            hostname: 'web-03',
            os: {
              family: 'linux',
              name: 'Ubuntu',
              version: '24.04',
              kernel: '6.8.0',
            },
            nics: [{ name: 'eth0', ipv4: ['10.0.0.12'] }],
          },
          software: [{ name: 'nginx', version: '1.27.0' }],
          reportedAt: '2026-07-31T12:00:00.000Z',
        });
        expect(ack.accepted).toBe(true);
      });

      it('RECORDS the unknown root keys it dropped, instead of losing the signal', async () => {
        // The root is no longer strict, so a newer agent degrades instead of 400-ing the host out of
        // the inventory — but a typo'd root key must not become silent, which is exactly the hazard
        // next to #1142 (an absent `software` key will come to mean "unchanged").
        process.env.APP_VERSION = 'v1.4.2';
        prisma.infraNode.findFirst.mockResolvedValue(null);
        prisma.infraNode.create.mockResolvedValue({
          id: 'node-new',
          state: 'PENDING',
        });

        const rawBody = { ...V1_BODY, deltaSince: '2026-07-31T11:00:00.000Z' };
        await service.ingestReport(
          AgentReportSchema.parse(rawBody),
          undefined,
          rawBody,
        );

        const createArg = firstArg<{
          data: { specs: { agentSkew?: unknown } };
        }>(prisma.infraNode.create);
        expect(createArg.data.specs.agentSkew).toEqual({
          droppedPaths: ['deltaSince'],
          agentAhead: false, // agentVersion 1.0.0 vs server v1.4.2 — not ahead
          serverVersion: 'v1.4.2',
        });
      });

      it('RECORDS a NESTED unknown key and a COERCED enum — not just the root', async () => {
        // A root-only diff reports "everything understood" for the two shapes a v3 agent is most
        // likely to send: a new key inside `host` (a nested `z.object` strips it silently) and an
        // enum value our own `.catch()` coerces. `os.family` is the sharp one — the contract requires
        // it so no consumer re-derives the platform, so swallowing a malformed one without a trace
        // would defeat the reason it is required.
        process.env.APP_VERSION = 'v1.4.2';
        prisma.infraNode.findFirst.mockResolvedValue(null);
        prisma.infraNode.create.mockResolvedValue({
          id: 'node-new',
          state: 'PENDING',
        });

        const rawBody = {
          ...V1_BODY,
          host: {
            ...V1_BODY.host,
            tpmVersion: '2.0',
            os: { ...V1_BODY.host.os, family: 'plan9' },
          },
        };
        await service.ingestReport(
          AgentReportSchema.parse(rawBody),
          undefined,
          rawBody,
        );

        const createArg = firstArg<{
          data: {
            specs: {
              agentSkew?: { droppedPaths?: string[]; coercedPaths?: string[] };
            };
          };
        }>(prisma.infraNode.create);
        expect(createArg.data.specs.agentSkew?.droppedPaths).toEqual([
          'host.tpmVersion',
        ]);
        expect(createArg.data.specs.agentSkew?.coercedPaths).toEqual([
          'host.os.family',
        ]);
      });

      it('PERSISTS diagnostics with the host inventory (an empty column becomes an answer)', async () => {
        // The whole justification for `diagnostics` in #1138: a fleet view must be able to say
        // "web-03: reporting unprivileged — no serial/model" instead of leaving the operator staring
        // at an empty row. Parsing it off the wire and discarding it delivers none of that.
        prisma.infraNode.findFirst.mockResolvedValue(null);
        prisma.infraNode.create.mockResolvedValue({
          id: 'node-diag',
          state: 'PENDING',
        });

        await service.ingestReport(
          AgentReportSchema.parse({
            ...V1_BODY,
            diagnostics: {
              warnings: ['hardware: skipped — dmidecode needs root'],
              privileged: false,
              durationMs: 812,
            },
          }),
        );

        const createArg = firstArg<{
          data: { specs: { diagnostics?: unknown } };
        }>(prisma.infraNode.create);
        expect(createArg.data.specs.diagnostics).toEqual({
          warnings: ['hardware: skipped — dmidecode needs root'],
          privileged: false,
          durationMs: 812,
        });
      });

      it('says the AGENT IS NEWER when it is — better diagnosis from data already on hand', async () => {
        // `agentVersion` already travels in every report, so the server can name the real cause
        // ("this agent is newer than me") instead of the generic "I do not understand these fields".
        process.env.APP_VERSION = 'v1.4.2';
        prisma.infraNode.findFirst.mockResolvedValue(null);
        prisma.infraNode.create.mockResolvedValue({
          id: 'node-new',
          state: 'PENDING',
        });

        const rawBody = { ...V1_BODY, agentVersion: 'v2.0.0', deltaSince: 'x' };
        await service.ingestReport(
          AgentReportSchema.parse(rawBody),
          undefined,
          rawBody,
        );

        const createArg = firstArg<{
          data: { specs: { agentSkew?: { agentAhead?: boolean } } };
        }>(prisma.infraNode.create);
        expect(createArg.data.specs.agentSkew?.agentAhead).toBe(true);
      });

      it('a report the server fully understands records NO skew (it self-heals)', async () => {
        prisma.infraNode.findFirst.mockResolvedValue(null);
        prisma.infraNode.create.mockResolvedValue({
          id: 'node-new',
          state: 'PENDING',
        });

        await service.ingestReport(
          AgentReportSchema.parse(V1_BODY),
          undefined,
          V1_BODY,
        );

        const createArg = firstArg<{
          data: { specs: Record<string, unknown> };
        }>(prisma.infraNode.create);
        expect(createArg.data.specs).not.toHaveProperty('agentSkew');
      });

      it('never leaks a REPORT DIAGNOSTIC into the linked Asset specs (and clears stale ones)', async () => {
        // `Asset.specs` is the INVENTORY snapshot an operator reads. Neither the wire-skew record nor
        // the collector's own run diagnostics are inventory facts; both stay on the node, where the
        // reporting provenance already lives.
        prisma.infraNode.findFirst.mockResolvedValue({
          id: 'node-1',
          assetId: 'asset-1',
          ipAddressSource: 'AGENT',
        });
        prisma.infraNode.update.mockResolvedValue({
          id: 'node-1',
          state: 'CONFIRMED',
        });
        prisma.asset.findFirst.mockResolvedValue({
          specs: {
            rack: 'A3',
            agentSkew: { droppedPaths: ['old'] },
            diagnostics: { privileged: true },
          },
        });

        const rawBody = {
          ...V1_BODY,
          deltaSince: 'x',
          diagnostics: { privileged: false, durationMs: 7 },
        };
        await service.ingestReport(
          AgentReportSchema.parse(rawBody),
          undefined,
          rawBody,
        );

        const updateArg = firstArg<{
          data: { specs: Record<string, unknown> };
        }>(prisma.asset.update);
        expect(updateArg.data.specs).not.toHaveProperty('agentSkew');
        expect(updateArg.data.specs).not.toHaveProperty('diagnostics');
        expect(updateArg.data.specs.rack).toBe('A3'); // human keys still preserved
      });

      it('promotes an IPv6 address on a v6-ONLY host (which used to show none at all)', async () => {
        prisma.infraNode.findFirst.mockResolvedValue(null);
        prisma.infraNode.create.mockResolvedValue({
          id: 'node-v6',
          state: 'PENDING',
        });

        await service.ingestReport(
          AgentReportSchema.parse({
            ...V1_BODY,
            host: {
              hostname: 'v6-only',
              nics: [
                {
                  name: 'eth0',
                  ipv6: [
                    { address: 'fe80::1', scope: 'link' },
                    {
                      address: '2001:db8::dead',
                      scope: 'global',
                      temporary: true,
                    },
                    { address: '2001:db8::7', scope: 'global' },
                  ],
                },
              ],
            },
          }),
        );

        const createArg = firstArg<{
          data: { ipAddress?: string; ipAddressSource?: string };
        }>(prisma.infraNode.create);
        // The link-local is unreachable and the temporary address rotates — neither belongs on a map.
        expect(createArg.data.ipAddress).toBe('2001:db8::7');
        expect(createArg.data.ipAddressSource).toBe('AGENT');
      });
    });

    // ── Auto-kind + container child nodes (#1139) ─────────────────────────────

    /** A structural copy of a parsed report, so a fixture built from it never aliases the original. */
    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

    describe('auto-kind — the server PROPOSES, the human still confirms (#1139)', () => {
      /** A report carrying whatever host facts the kind inference reads. */
      const reportWith = (host: Record<string, unknown>) =>
        AgentReportSchema.parse({
          ...clone(FULL_REPORT),
          host: { hostname: 'web-01', ...host },
        });

      beforeEach(() => {
        prisma.infraNode.findFirst.mockResolvedValue(null);
        prisma.infraNode.create.mockResolvedValue({
          id: 'node-1',
          state: 'PENDING',
        });
      });

      it('lands a KVM guest as a VM, not as one more PHYSICAL_HOST', async () => {
        // The whole point of the issue: a Proxmox host and its 8 guests used to arrive as 9
        // identical boxes the operator re-classified by hand before blast radius meant anything.
        await service.ingestReport(
          reportWith({ virtualization: { type: 'kvm' } }),
        );
        expect(
          firstArg<{ data: { kind: string } }>(prisma.infraNode.create).data
            .kind,
        ).toBe('VM');
      });

      it('lands an LXC/Docker guest as a CONTAINER', async () => {
        await service.ingestReport(
          reportWith({ virtualization: { type: 'lxc' } }),
        );
        expect(
          firstArg<{ data: { kind: string } }>(prisma.infraNode.create).data
            .kind,
        ).toBe('CONTAINER');
      });

      it('a POSITIVE bare-metal finding is PHYSICAL_HOST', async () => {
        await service.ingestReport(
          reportWith({ virtualization: { type: 'none' } }),
        );
        expect(
          firstArg<{ data: { kind: string } }>(prisma.infraNode.create).data
            .kind,
        ).toBe('PHYSICAL_HOST');
      });

      it('NO evidence keeps the pre-#1139 default — a legacy agent lands exactly where it did', async () => {
        // `chassis: unknown` means the probe did not run, which is NOT "bare metal". Guessing here
        // would silently pre-empt the human's call; falling back is the honest answer.
        await service.ingestReport(reportWith({ chassis: 'unknown' }));
        expect(
          firstArg<{ data: { kind: string } }>(prisma.infraNode.create).data
            .kind,
        ).toBe('PHYSICAL_HOST');

        prisma.infraNode.create.mockClear();
        await service.ingestReport(FULL_REPORT); // a pre-v2 report: no chassis, no virtualization
        expect(
          firstArg<{ data: { kind: string } }>(prisma.infraNode.create).data
            .kind,
        ).toBe('PHYSICAL_HOST');
      });

      it('NEVER re-kinds a node a human already confirmed and classified', async () => {
        // The hard rule. `refreshKnownNode` exists to protect human curation: the agent owns FACTS,
        // the human owns curation, and `kind` is curation the moment a human has touched it.
        prisma.infraNode.findFirst.mockResolvedValue({
          id: 'node-known',
          assetId: null,
          ipAddressSource: 'AGENT',
        });
        prisma.infraNode.update.mockResolvedValue({
          id: 'node-known',
          state: 'CONFIRMED',
        });

        await service.ingestReport(
          reportWith({ virtualization: { type: 'vmware' } }),
        );

        expect(prisma.infraNode.create).not.toHaveBeenCalled();
        const updateArg = firstArg<{ data: Record<string, unknown> }>(
          prisma.infraNode.update,
        );
        expect(updateArg.data).not.toHaveProperty('kind');
        expect(updateArg.data).not.toHaveProperty('label');
        expect(updateArg.data).not.toHaveProperty('state');
      });
    });

    describe('container child nodes + RUNS_ON edges (#1139)', () => {
      /** A report whose host runs containers — `containers` ABSENT unless a test supplies it. */
      const reportWithContainers = (containers?: unknown[]) =>
        AgentReportSchema.parse({
          ...clone(FULL_REPORT),
          host: {
            ...clone(FULL_REPORT.host),
            ...(containers !== undefined ? { containers } : {}),
          },
        });

      /** Land the host on the CREATE branch, with no container children known yet. */
      function hostIsNew(): void {
        prisma.infraNode.findFirst.mockResolvedValue(null);
        prisma.infraNode.create.mockResolvedValue({
          id: 'node-host',
          state: 'PENDING',
        });
        prisma.infraNode.findMany.mockResolvedValue([]);
        prisma.infraEdge.findMany.mockResolvedValue([]);
      }

      it('an ABSENT containers key touches nothing — a downgraded agent never retires children', async () => {
        // ABSENT means "the collector never probed". Reading it as "this host runs none" would let
        // an agent downgrade, or a momentarily unreadable socket, wipe a host's whole topology.
        hostIsNew();
        await service.ingestReport(reportWithContainers(), AGENT_SA);
        expect(prisma.infraNode.findMany).not.toHaveBeenCalled();
        expect(prisma.infraNode.updateMany).not.toHaveBeenCalled();
        expect(prisma.infraEdge.create).not.toHaveBeenCalled();
      });

      it('mints a PENDING CONTAINER child with an ACTIVE RUNS_ON edge back to its host', async () => {
        hostIsNew();
        prisma.infraNode.create
          .mockResolvedValueOnce({ id: 'node-host', state: 'PENDING' })
          .mockResolvedValueOnce({ id: 'node-c1' });

        await service.ingestReport(
          reportWithContainers([
            {
              name: 'lazyit-api',
              image: 'ghcr.io/acme/api:1.4.0',
              state: 'running',
            },
          ]),
          AGENT_SA,
        );

        const calls = prisma.infraNode.create.mock.calls as unknown[][];
        const child = (calls[1][0] as { data: Record<string, unknown> }).data;
        expect(child.kind).toBe('CONTAINER');
        expect(child.label).toBe('lazyit-api');
        // The human gate is untouched: a child is a PROPOSAL, exactly like its host (ADR-0074 §1).
        expect(child.state).toBe('PENDING');
        expect(child.source).toBe('AGENT');
        expect(child.status).toBe('ONLINE');
        // Keyed on the NAME, scoped to the host — never on the runtime id, which every recreate changes.
        expect(child.externalId).toBe('machine-id-xyz/container/lazyit-api');
        expect(child.reportingSource).toBe('agent:abc123');

        expect(prisma.infraEdge.create).toHaveBeenCalledWith({
          data: { sourceId: 'node-c1', targetId: 'node-host', kind: 'RUNS_ON' },
        });
      });

      it('a RECREATED container is refreshed, never duplicated — and never re-curated', async () => {
        // `docker compose up --force-recreate` mints a brand-new runtime id every time. Keying on it
        // would leave a fresh PENDING proposal per deploy and orphan the previous node.
        prisma.infraNode.findFirst.mockResolvedValue({
          id: 'node-host',
          assetId: null,
          ipAddressSource: 'AGENT',
        });
        prisma.infraNode.update.mockResolvedValue({
          id: 'node-host',
          state: 'CONFIRMED',
        });
        prisma.infraNode.findMany.mockResolvedValue([
          { id: 'node-c1', externalId: 'machine-id-xyz/container/lazyit-api' },
        ]);
        // `target.deletedAt: null` — a LIVE host, which is what makes this edge "already parented".
        prisma.infraEdge.findMany.mockResolvedValue([
          { id: 'edge-1', sourceId: 'node-c1', target: { deletedAt: null } },
        ]);

        await service.ingestReport(
          reportWithContainers([
            { name: 'lazyit-api', id: 'aaaaaaaaaaaa', state: 'running' },
          ]),
          AGENT_SA,
        );

        expect(prisma.infraNode.create).not.toHaveBeenCalled();
        expect(enrollment.tryCharge).not.toHaveBeenCalled();
        // Facts + liveness refresh; curation (kind/label/state/position) is left alone.
        const childUpdate = (
          prisma.infraNode.update.mock.calls as unknown[][]
        ).find(
          (c) => (c[0] as { where: { id: string } }).where.id === 'node-c1',
        )?.[0] as { data: Record<string, unknown> };
        expect(childUpdate.data.status).toBe('ONLINE');
        expect(childUpdate.data).not.toHaveProperty('kind');
        expect(childUpdate.data).not.toHaveProperty('label');
        expect(childUpdate.data).not.toHaveProperty('state');
        // The edge is already active — re-opening it would trip the one-active-RUNS_ON index.
        expect(prisma.infraEdge.create).not.toHaveBeenCalled();
      });

      it('re-opens a MISSING RUNS_ON edge (self-heal), so a child never floats unparented', async () => {
        prisma.infraNode.findFirst.mockResolvedValue({
          id: 'node-host',
          assetId: null,
          ipAddressSource: 'AGENT',
        });
        prisma.infraNode.update.mockResolvedValue({
          id: 'node-host',
          state: 'CONFIRMED',
        });
        prisma.infraNode.findMany.mockResolvedValue([
          { id: 'node-c1', externalId: 'machine-id-xyz/container/lazyit-api' },
        ]);
        prisma.infraEdge.findMany.mockResolvedValue([]); // no active RUNS_ON

        await service.ingestReport(
          reportWithContainers([{ name: 'lazyit-api', state: 'running' }]),
          AGENT_SA,
        );

        expect(prisma.infraEdge.create).toHaveBeenCalledWith({
          data: { sourceId: 'node-c1', targetId: 'node-host', kind: 'RUNS_ON' },
        });
      });

      it('re-parents a child still wired to a DISCARDED host, instead of leaving it orphaned', async () => {
        // Discarding a node soft-deletes it and leaves its edges open. The next report cannot reuse
        // the dead row (the dedup lookup is live-scoped), so it mints a NEW host node — and the
        // children, whose RUNS_ON edge was "active", were skipped by the self-heal and stayed wired
        // to a node that is off the map. The child then floated unparented forever and the new host
        // showed no children, which is precisely what §2's self-healing promises cannot happen.
        prisma.infraNode.findFirst.mockResolvedValue(null); // the old host row is soft-deleted
        prisma.infraNode.create.mockResolvedValueOnce({
          id: 'node-host-2',
          state: 'PENDING',
        });
        prisma.infraNode.findMany.mockResolvedValue([
          { id: 'node-c1', externalId: 'machine-id-xyz/container/lazyit-api' },
        ]);
        prisma.infraEdge.findMany.mockResolvedValue([
          {
            id: 'edge-dead',
            sourceId: 'node-c1',
            target: { deletedAt: new Date('2026-07-01T00:00:00.000Z') },
          },
        ]);

        await service.ingestReport(
          reportWithContainers([{ name: 'lazyit-api', state: 'running' }]),
          AGENT_SA,
        );

        // Close the edge to the discarded host FIRST — the one-active-RUNS_ON-per-source partial
        // unique index would refuse a second open edge otherwise.
        const closed = firstArg<{
          where: { id: { in: string[] } };
          data: { endedAt: Date };
        }>(prisma.infraEdge.updateMany);
        expect(closed.where).toEqual({ id: { in: ['edge-dead'] } });
        expect(closed.data.endedAt).toBeInstanceOf(Date);
        expect(prisma.infraEdge.create).toHaveBeenCalledWith({
          data: {
            sourceId: 'node-c1',
            targetId: 'node-host-2',
            kind: 'RUNS_ON',
          },
        });
      });

      it('leaves a child a HUMAN re-parented onto another LIVE node completely alone', async () => {
        // The rule the re-parenting fix must not break: only a DISCARDED target is healed. A live
        // target is a human's deliberate curation ("this container really runs on that VM"), and
        // re-pointing it every 15 minutes would make the graph un-editable.
        prisma.infraNode.findFirst.mockResolvedValue({
          id: 'node-host',
          assetId: null,
          ipAddressSource: 'AGENT',
        });
        prisma.infraNode.update.mockResolvedValue({
          id: 'node-host',
          state: 'CONFIRMED',
        });
        prisma.infraNode.findMany.mockResolvedValue([
          { id: 'node-c1', externalId: 'machine-id-xyz/container/lazyit-api' },
        ]);
        prisma.infraEdge.findMany.mockResolvedValue([
          { id: 'edge-live', sourceId: 'node-c1', target: { deletedAt: null } },
        ]);

        await service.ingestReport(
          reportWithContainers([{ name: 'lazyit-api', state: 'running' }]),
          AGENT_SA,
        );

        expect(prisma.infraEdge.updateMany).not.toHaveBeenCalled();
        expect(prisma.infraEdge.create).not.toHaveBeenCalled();
      });

      it('a VANISHED container goes OFFLINE — never soft-deleted behind the operator', async () => {
        // Deleting is the human's call (the existing Discard action). Auto-deleting would also churn:
        // the dedup index is over LIVE rows, so a flapping container would accumulate dead rows.
        prisma.infraNode.findFirst.mockResolvedValue({
          id: 'node-host',
          assetId: null,
          ipAddressSource: 'AGENT',
        });
        prisma.infraNode.update.mockResolvedValue({
          id: 'node-host',
          state: 'CONFIRMED',
        });
        prisma.infraNode.findMany.mockResolvedValue([
          { id: 'node-gone', externalId: 'machine-id-xyz/container/old-job' },
        ]);
        prisma.infraEdge.findMany.mockResolvedValue([]);

        await service.ingestReport(reportWithContainers([]), AGENT_SA);

        expect(prisma.infraNode.updateMany).toHaveBeenCalledWith({
          where: { id: { in: ['node-gone'] } },
          data: { status: 'OFFLINE' },
        });
        expect(prisma.infraNode.create).not.toHaveBeenCalled();
      });

      it('an EMPTY list is a positive finding — the probe ran and this host runs none', async () => {
        hostIsNew();
        await service.ingestReport(reportWithContainers([]), AGENT_SA);
        // It still LOOKS for children to retire (that is the whole difference from an absent key).
        expect(prisma.infraNode.findMany).toHaveBeenCalled();
      });

      it('a spent enrollment budget stops enrolling children WITHOUT failing the host report', async () => {
        // The host row is already durable here. A 429 would read to the agent as "nothing landed"
        // and it would retry the identical report forever, losing the host as well as the children.
        hostIsNew();
        prisma.infraNode.create.mockResolvedValueOnce({
          id: 'node-host',
          state: 'PENDING',
        });
        enrollment.tryCharge.mockReturnValue(false);

        const ack = await service.ingestReport(
          reportWithContainers([{ name: 'a' }, { name: 'b' }]),
          AGENT_SA,
        );

        expect(ack.accepted).toBe(true);
        expect(prisma.infraNode.create).toHaveBeenCalledTimes(1); // the host only
      });

      it('a container reconcile failure NEVER fails the host report', async () => {
        // Degrade, never reject — the same posture the contract takes. Losing the container topology
        // for one tick is a stale field; losing the report makes the HOST vanish from the inventory.
        hostIsNew();
        prisma.infraNode.findMany.mockRejectedValue(new Error('db hiccup'));

        const ack = await service.ingestReport(
          reportWithContainers([{ name: 'a' }]),
          AGENT_SA,
        );
        expect(ack).toEqual({
          nodeId: 'node-host',
          state: 'PENDING',
          accepted: true,
        });
      });

      it('a REFUSED enrollment never becomes a RETIREMENT — the budget stops creating, not the truth', async () => {
        // The enrollment budget is per service account and shared fleet-wide, and children now spend
        // it too, so exhausting it mid-list is a NORMAL rollout event, not an attack. The retire
        // sweep must therefore only consider containers the AGENT reported as absent. Reading
        // "the server declined to enrol this one" as "this one vanished" marked still-running,
        // already-confirmed children OFFLINE — a false outage on the operator's canvas, produced by
        // the throttle that was supposed to be invisible.
        prisma.infraNode.findFirst.mockResolvedValue({
          id: 'node-host',
          assetId: null,
          ipAddressSource: 'AGENT',
        });
        prisma.infraNode.update.mockResolvedValue({
          id: 'node-host',
          state: 'CONFIRMED',
        });
        prisma.infraNode.findMany.mockResolvedValue([
          { id: 'node-keep', externalId: 'machine-id-xyz/container/keep' },
        ]);
        prisma.infraEdge.findMany.mockResolvedValue([
          {
            id: 'edge-keep',
            sourceId: 'node-keep',
            target: { deletedAt: null },
          },
        ]);
        enrollment.tryCharge.mockReturnValue(false);

        // `brand-new` exhausts the budget; `keep` is listed AFTER it and is already known + running.
        await service.ingestReport(
          reportWithContainers([
            { name: 'brand-new', state: 'running' },
            { name: 'keep', state: 'running' },
          ]),
          AGENT_SA,
        );

        expect(prisma.infraNode.updateMany).not.toHaveBeenCalled();
        // And it is still REFRESHED: abandoning the rest of the list would freeze its
        // `lastReportedAt`, and the §4 staleness sweeper would retire it a few hours later instead —
        // the same false outage, only slower and harder to trace back to the throttle.
        const keepUpdate = (
          prisma.infraNode.update.mock.calls as unknown[][]
        ).find(
          (c) => (c[0] as { where: { id: string } }).where.id === 'node-keep',
        )?.[0] as { data: Record<string, unknown> } | undefined;
        expect(keepUpdate?.data.status).toBe('ONLINE');
        expect(keepUpdate?.data.lastReportedAt).toBeInstanceOf(Date);
      });

      it('still retires a container the agent genuinely stopped listing, budget or no budget', async () => {
        // The other half of the same rule: a spent budget must not SUPPRESS a real retirement either.
        prisma.infraNode.findFirst.mockResolvedValue({
          id: 'node-host',
          assetId: null,
          ipAddressSource: 'AGENT',
        });
        prisma.infraNode.update.mockResolvedValue({
          id: 'node-host',
          state: 'CONFIRMED',
        });
        prisma.infraNode.findMany.mockResolvedValue([
          { id: 'node-gone', externalId: 'machine-id-xyz/container/old-job' },
        ]);
        prisma.infraEdge.findMany.mockResolvedValue([]);
        enrollment.tryCharge.mockReturnValue(false);

        await service.ingestReport(
          reportWithContainers([{ name: 'brand-new', state: 'running' }]),
          AGENT_SA,
        );

        expect(prisma.infraNode.updateMany).toHaveBeenCalledWith({
          where: { id: { in: ['node-gone'] } },
          data: { status: 'OFFLINE' },
        });
      });

      it('scopes the child lookup to THIS host, so two hosts running `redis` stay two nodes', async () => {
        hostIsNew();
        await service.ingestReport(
          reportWithContainers([{ name: 'redis' }]),
          AGENT_SA,
        );
        expect(
          firstArg<{ where: Record<string, unknown> }>(
            prisma.infraNode.findMany,
          ).where,
        ).toEqual({
          reportingSource: 'agent:abc123',
          externalId: { startsWith: 'machine-id-xyz/container/' },
        });
      });
    });

    // ── The new-node enrollment rate per reporter (#1134) ─────────────────────

    describe('new-node enrollment throttle (#1134)', () => {
      it('THE HAPPY PATH: a known host checking in is never charged the enrollment budget', async () => {
        // The legitimate agent — one node, a report every 15 minutes — takes the KNOWN-key refresh
        // path. It creates no row, so it must not be charged, let alone throttled. A limit that can
        // 429 this case is worse than no limit at all. This is also why an untriaged tray is now
        // irrelevant: nothing about existing rows is consulted on this path or any other.
        prisma.infraNode.findFirst.mockResolvedValue({
          id: 'node-1',
          assetId: null,
          ipAddressSource: 'AGENT',
        });
        prisma.infraNode.update.mockResolvedValue({
          id: 'node-1',
          state: 'CONFIRMED',
        });

        for (let tick = 0; tick < 96; tick++) {
          const ack = await service.ingestReport(FULL_REPORT, AGENT_SA);
          expect(ack.accepted).toBe(true);
        }
        expect(enrollment.assertWithinBudget).not.toHaveBeenCalled();
        expect(prisma.infraNode.create).not.toHaveBeenCalled();
      });

      it('charges the enrollment budget on the CREATE branch, keyed on the caller principal', async () => {
        prisma.infraNode.findFirst.mockResolvedValue(null);
        prisma.infraNode.create.mockResolvedValue({
          id: 'node-1',
          state: 'PENDING',
        });

        const ack = await service.ingestReport(FULL_REPORT, AGENT_SA);

        expect(ack).toEqual({
          nodeId: 'node-1',
          state: 'PENDING',
          accepted: true,
        });
        // Keyed on the SERVER-resolved principal — never on `reportingSource`, a client-chosen body
        // field an attacker rotates per request.
        expect(enrollment.assertWithinBudget).toHaveBeenCalledTimes(1);
        expect(enrollment.assertWithinBudget).toHaveBeenCalledWith(AGENT_SA);
      });

      it('a NEW host is refused (429) once the reporter has spent its window, and NO row is written', async () => {
        prisma.infraNode.findFirst.mockResolvedValue(null);
        enrollment.assertWithinBudget.mockImplementation(() => {
          throw new HttpException('too many', HttpStatus.TOO_MANY_REQUESTS);
        });

        let thrown: unknown;
        try {
          await service.ingestReport(FULL_REPORT, AGENT_SA);
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(HttpException);
        expect((thrown as HttpException).getStatus()).toBe(429);
        // The whole point: the throttle runs BEFORE the insert, so nothing is created past it.
        expect(prisma.infraNode.create).not.toHaveBeenCalled();
      });

      it('a throttled reporter still refreshes its already-known hosts', async () => {
        // The property that makes this safe to ship: hitting the enrollment limit degrades
        // DISCOVERY only. Liveness and inventory for hosts the operator already has never stop, so
        // a tripped limit can never turn the topology map into a false outage.
        enrollment.assertWithinBudget.mockImplementation(() => {
          throw new HttpException('too many', HttpStatus.TOO_MANY_REQUESTS);
        });
        prisma.infraNode.findFirst.mockResolvedValue({
          id: 'node-known',
          assetId: null,
          ipAddressSource: 'AGENT',
        });
        prisma.infraNode.update.mockResolvedValue({
          id: 'node-known',
          state: 'CONFIRMED',
        });

        const ack = await service.ingestReport(FULL_REPORT, AGENT_SA);
        expect(ack.accepted).toBe(true);
      });

      it('a NON-service caller is charged too (never a way around the limit)', async () => {
        // `infra:report` is grantable to a human role. The limiter buckets by principal kind; the
        // service's job is simply to hand it whatever principal it was called with.
        prisma.infraNode.findFirst.mockResolvedValue(null);
        prisma.infraNode.create.mockResolvedValue({
          id: 'node-1',
          state: 'PENDING',
        });

        await service.ingestReport(FULL_REPORT, HUMAN);

        expect(enrollment.assertWithinBudget).toHaveBeenCalledWith(HUMAN);
      });

      it('the P2002 race loser is charged once and still acks (a repeat report is idempotent)', async () => {
        // The create attempt spends the slot even though the row turned out to already exist. That
        // over-charges by one per race — rare, self-limiting, and the conservative direction: the
        // limiter may cost a slot that went unused, never grant one that was not held.
        prisma.infraNode.findFirst
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: 'node-raced' });
        prisma.infraNode.create.mockRejectedValueOnce(new KnownError('P2002'));
        prisma.infraNode.update.mockResolvedValue({
          id: 'node-raced',
          state: 'PENDING',
        });

        const ack = await service.ingestReport(FULL_REPORT, AGENT_SA);
        expect(ack.accepted).toBe(true);
        expect(enrollment.assertWithinBudget).toHaveBeenCalledTimes(1);
      });

      it('persists NO reporter attribution on the row — the throttle key never reaches the schema', async () => {
        // The CEO decision behind this rework: no `reportedBySaId` column, no FK, no index, no
        // migration. The principal is an EPHEMERAL throttle key only, so ADR-0074 §8's #1136
        // correction — agent writes are unattributed — remains true.
        prisma.infraNode.findFirst.mockResolvedValue(null);
        prisma.infraNode.create.mockResolvedValue({
          id: 'node-1',
          state: 'PENDING',
        });

        await service.ingestReport(FULL_REPORT, AGENT_SA);

        const createArg = firstArg<{ data: Record<string, unknown> }>(
          prisma.infraNode.create,
        );
        expect(createArg.data).not.toHaveProperty('reportedBySaId');
        expect(JSON.stringify(createArg.data)).not.toContain('sa-agent');
      });
    });
  });

  // ── Reporting-agent confirmation (ADR-0074 §3) — the human review-tray gate ──

  describe('confirmNode', () => {
    /** Mock the node reads confirmNode does (the method returns the enriched detail after the flip). */
    function mockDetailReadAfterConfirm(node: Record<string, unknown>): void {
      // The FIRST findFirst (getNode at the top) must see the PENDING node so the flip runs; every
      // later findFirst (the fire-and-forget search re-read + the getNodeDetail re-read) sees CONFIRMED.
      prisma.infraNode.findFirst
        .mockResolvedValueOnce(node)
        .mockResolvedValue({ ...node, state: 'CONFIRMED' });
      prisma.infraEdge.findMany.mockResolvedValue([]); // getNodeDetail children lookup
    }

    it('confirms a PENDING node → state CONFIRMED + a backing Asset minted (trackAsAsset default), host facts carried over', async () => {
      const PENDING = {
        id: 'node-1',
        label: 'web-01',
        state: 'PENDING',
        assetId: null,
        specs: { host: { hostname: 'web-01' }, agentVersion: '1.0.0' },
      };
      mockDetailReadAfterConfirm(PENDING);
      assets.create.mockResolvedValue({ id: 'asset-new' });
      prisma.infraNode.update.mockResolvedValue({
        id: 'node-1',
        state: 'CONFIRMED',
        assetId: 'asset-new',
      });

      await service.confirmNode('node-1', {}, HUMAN);

      // The backing Asset is minted via the reused asset-create path, host facts carried over + marked.
      expect(assets.create).toHaveBeenCalledWith(
        {
          name: 'web-01',
          status: 'UNKNOWN',
          specs: {
            host: { hostname: 'web-01' },
            agentVersion: '1.0.0',
            _infraAutoCreated: true,
          },
        },
        HUMAN,
      );
      // The node is flipped to CONFIRMED and wired to the freshly-created asset.
      const arg = firstArg<{
        data: { state: string; assetId?: string };
      }>(prisma.infraNode.update);
      expect(arg.data.state).toBe('CONFIRMED');
      expect(arg.data.assetId).toBe('asset-new');
    });

    it('never carries a REPORT DIAGNOSTIC into the minted Asset specs (#1138)', async () => {
      // The repeat-report path strips these, but confirm mints the Asset from the node's WHOLE specs
      // blob — so the guard has to hold on both paths, or the very first thing a confirmed host's
      // inventory snapshot contains is a wire diagnostic about a report the SERVER half-understood.
      const PENDING = {
        id: 'node-1',
        label: 'web-01',
        state: 'PENDING',
        assetId: null,
        specs: {
          host: { hostname: 'web-01' },
          reportedAt: '2026-07-31T12:00:00.000Z',
          agentSkew: { droppedPaths: ['deltaSince'], agentAhead: true },
          diagnostics: { privileged: false, durationMs: 812 },
        },
      };
      mockDetailReadAfterConfirm(PENDING);
      assets.create.mockResolvedValue({ id: 'asset-new' });
      prisma.infraNode.update.mockResolvedValue({
        id: 'node-1',
        state: 'CONFIRMED',
        assetId: 'asset-new',
      });

      await service.confirmNode('node-1', {}, HUMAN);

      const createArg = firstArg<{ specs: Record<string, unknown> }>(
        assets.create,
      );
      expect(createArg.specs).not.toHaveProperty('agentSkew');
      expect(createArg.specs).not.toHaveProperty('diagnostics');
      // The inventory facts and the provenance marker still land.
      expect(createArg.specs.host).toEqual({ hostname: 'web-01' });
      expect(createArg.specs._infraAutoCreated).toBe(true);
    });

    it('applies kind/label overrides and names the minted Asset with the override label', async () => {
      const PENDING = {
        id: 'node-1',
        label: 'web-01',
        state: 'PENDING',
        assetId: null,
        specs: { host: { hostname: 'web-01' } },
      };
      mockDetailReadAfterConfirm(PENDING);
      assets.create.mockResolvedValue({ id: 'asset-new' });
      prisma.infraNode.update.mockResolvedValue({ id: 'node-1' });

      await service.confirmNode(
        'node-1',
        { kind: 'VM', label: 'prod-web' },
        HUMAN,
      );

      // The Asset takes the OVERRIDE label, not the agent's hostname.
      const createArg = firstArg<{ name: string }>(assets.create);
      expect(createArg.name).toBe('prod-web');
      const arg = firstArg<{ data: { kind?: string; label?: string } }>(
        prisma.infraNode.update,
      );
      expect(arg.data.kind).toBe('VM');
      expect(arg.data.label).toBe('prod-web');
    });

    it('trackAsAsset:false → CONFIRMED but NO Asset (graph-only)', async () => {
      const PENDING = {
        id: 'node-1',
        label: 'redis',
        state: 'PENDING',
        assetId: null,
        specs: {},
      };
      mockDetailReadAfterConfirm(PENDING);
      prisma.infraNode.update.mockResolvedValue({ id: 'node-1' });

      await service.confirmNode('node-1', { trackAsAsset: false }, HUMAN);

      expect(assets.create).not.toHaveBeenCalled();
      const arg = firstArg<{ data: { state: string; assetId?: string } }>(
        prisma.infraNode.update,
      );
      expect(arg.data.state).toBe('CONFIRMED');
      // No asset minted → no assetId written.
      expect(arg.data).not.toHaveProperty('assetId');
    });

    it('promotes a sanitized hardware serial to the minted Asset.serial, modelId left null (#1081)', async () => {
      const PENDING = {
        id: 'node-1',
        label: 'web-01',
        state: 'PENDING',
        assetId: null,
        specs: {
          host: { hostname: 'web-01', hardware: { serial: '  SN-REAL-123  ' } },
        },
      };
      mockDetailReadAfterConfirm(PENDING);
      assets.create.mockResolvedValue({ id: 'asset-new' });
      prisma.infraNode.update.mockResolvedValue({
        id: 'node-1',
        state: 'CONFIRMED',
      });

      await service.confirmNode('node-1', {}, HUMAN);

      const createArg = firstArg<{ serial?: string; modelId?: string }>(
        assets.create,
      );
      expect(createArg.serial).toBe('SN-REAL-123'); // trimmed + promoted
      expect(createArg).not.toHaveProperty('modelId'); // no AssetModel auto-create
    });

    it('drops a junk serial (dmidecode placeholder) — Asset.serial stays null, raw value kept in specs', async () => {
      const PENDING = {
        id: 'node-1',
        label: 'web-01',
        state: 'PENDING',
        assetId: null,
        specs: {
          host: {
            hostname: 'web-01',
            hardware: { serial: 'To be filled by O.E.M.' },
          },
        },
      };
      mockDetailReadAfterConfirm(PENDING);
      assets.create.mockResolvedValue({ id: 'asset-new' });
      prisma.infraNode.update.mockResolvedValue({
        id: 'node-1',
        state: 'CONFIRMED',
      });

      await service.confirmNode('node-1', {}, HUMAN);

      const createArg = firstArg<{
        serial?: string;
        specs: { host: { hardware: { serial: string } } };
      }>(assets.create);
      // No canonical serial promoted…
      expect(createArg).not.toHaveProperty('serial');
      // …but the raw dmidecode value still survives in the specs blob.
      expect(createArg.specs.host.hardware.serial).toBe(
        'To be filled by O.E.M.',
      );
    });

    it('a serial-unique collision (P2002) retries WITHOUT the serial rather than failing the confirm', async () => {
      const PENDING = {
        id: 'node-1',
        label: 'web-01',
        state: 'PENDING',
        assetId: null,
        specs: {
          host: { hostname: 'web-01', hardware: { serial: 'DUP-SERIAL' } },
        },
      };
      mockDetailReadAfterConfirm(PENDING);
      // First mint (with serial) collides on assets_serial_active_key; the retry (no serial) succeeds.
      assets.create
        .mockRejectedValueOnce(
          new KnownError('P2002', { target: 'assets_serial_active_key' }),
        )
        .mockResolvedValueOnce({ id: 'asset-new' });
      prisma.infraNode.update.mockResolvedValue({
        id: 'node-1',
        state: 'CONFIRMED',
      });

      await service.confirmNode('node-1', {}, HUMAN);

      expect(assets.create).toHaveBeenCalledTimes(2);
      const firstCall = (assets.create.mock.calls as unknown[][])[0][0] as {
        serial?: string;
      };
      const retryCall = (assets.create.mock.calls as unknown[][])[1][0] as {
        serial?: string;
      };
      expect(firstCall.serial).toBe('DUP-SERIAL'); // attempted with the serial
      expect(retryCall).not.toHaveProperty('serial'); // retried without it
      // The confirm still flips the node to CONFIRMED (never a 409).
      const arg = firstArg<{ data: { state: string } }>(
        prisma.infraNode.update,
      );
      expect(arg.data.state).toBe('CONFIRMED');
    });

    it('is an idempotent no-op on an already-CONFIRMED node (no Asset minted, no re-flip write)', async () => {
      prisma.infraNode.findFirst.mockResolvedValue({
        id: 'node-1',
        label: 'web-01',
        state: 'CONFIRMED',
        assetId: 'asset-1',
      });
      prisma.infraEdge.findMany.mockResolvedValue([]);
      prisma.asset.findFirst.mockResolvedValue({ name: 'srv-prod-01' });

      const detail = await service.confirmNode('node-1', {}, HUMAN);

      // No mutation: neither the asset-create nor the node update is invoked.
      expect(assets.create).not.toHaveBeenCalled();
      expect(prisma.infraNode.update).not.toHaveBeenCalled();
      // It still returns the current enriched detail.
      expect(detail.state).toBe('CONFIRMED');
    });

    it('404s when the node is missing or soft-deleted (getNode guard)', async () => {
      prisma.infraNode.findFirst.mockResolvedValue(null);
      await expect(
        service.confirmNode('nope', {}, HUMAN),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.infraNode.update).not.toHaveBeenCalled();
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

      // Queried the inverse active RUNS_ON (targetId = me, endedAt null) AND excluded soft-deleted
      // sources (#1067): InfraEdge is not soft-deletable, so the query must guard `source.deletedAt`.
      expect(prisma.infraEdge.findMany).toHaveBeenCalledWith({
        where: {
          targetId: 'host-1',
          kind: 'RUNS_ON',
          endedAt: null,
          source: { deletedAt: null },
        },
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

    it('excludes soft-deleted child nodes reached via a still-active RUNS_ON edge (#1067)', async () => {
      prisma.infraNode.findFirst.mockResolvedValue({
        id: 'host-1',
        label: 'host',
        assetId: null,
      });
      prisma.infraEdge.findMany.mockResolvedValue([]);

      await service.getNodeDetail('host-1');

      // The children query must carry the nested soft-delete guard so a soft-deleted child whose edge
      // is still active never surfaces (a node's edges are not closed when the node is soft-deleted).
      const where = (
        prisma.infraEdge.findMany.mock.calls as Array<
          [{ where: { source?: { deletedAt?: unknown } } }]
        >
      )[0][0].where;
      expect(where.source).toEqual({ deletedAt: null });
    });

    it('surfaces a SOFT duplicate-IP conflict — other LIVE nodes with the same ipAddress, self excluded (ADR-0090, #847)', async () => {
      prisma.infraNode.findFirst.mockResolvedValue({
        id: 'node-1',
        label: 'web-01',
        assetId: null,
        ipAddress: '10.0.0.5',
      });
      prisma.infraEdge.findMany.mockResolvedValue([]);
      // Two OTHER live nodes share the exact IP (the soft-delete extension scopes this findMany).
      prisma.infraNode.findMany.mockResolvedValue([
        { id: 'node-2', label: 'api-02', kind: 'VM', status: 'ONLINE' },
        {
          id: 'node-3',
          label: 'db-03',
          kind: 'PHYSICAL_HOST',
          status: 'UNKNOWN',
        },
      ]);

      const detail = await service.getNodeDetail('node-1');

      // Exact-IP match, self excluded — a lean display signal, no DB uniqueness involved.
      expect(prisma.infraNode.findMany).toHaveBeenCalledWith({
        where: { ipAddress: '10.0.0.5', id: { not: 'node-1' } },
        orderBy: { label: 'asc' },
        select: { id: true, label: true, kind: true, status: true },
      });
      expect(detail.ipConflict).toEqual([
        { id: 'node-2', label: 'api-02', kind: 'VM', status: 'ONLINE' },
        {
          id: 'node-3',
          label: 'db-03',
          kind: 'PHYSICAL_HOST',
          status: 'UNKNOWN',
        },
      ]);
    });

    it('never queries for a conflict when the node has no IP (empty signal, ADR-0090)', async () => {
      prisma.infraNode.findFirst.mockResolvedValue({
        id: 'node-1',
        label: 'web-01',
        assetId: null,
        ipAddress: null,
      });
      prisma.infraEdge.findMany.mockResolvedValue([]);

      const detail = await service.getNodeDetail('node-1');

      expect(detail.ipConflict).toEqual([]);
      expect(prisma.infraNode.findMany).not.toHaveBeenCalled();
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
      const arg = firstArg<{ select?: { asset?: { select?: unknown } } }>(
        prisma.infraNode.findMany,
      );
      expect(arg.select?.asset?.select).toBeDefined();

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

    // ── The lean list projection (#1135) ────────────────────────────────────
    // `specs` is an agent's whole host inventory (the full installed-software list, ~1500 entries on
    // a real Linux box). The PENDING tray polls this list every 40s and the create-agent wizard every
    // 5s, so shipping the blob per row turns a liveness poll into megabytes. The projection is the
    // fix: `select` the scalars the list actually renders, never `specs` — the drill-in
    // (`getNodeDetail`) keeps the full blob, which is where the inventory panel reads it.
    it('SELECTS an explicit column list that excludes `specs` (never the full inventory blob)', async () => {
      prisma.infraNode.findMany.mockResolvedValue([]);

      await service.listNodes();

      const arg = firstArg<{
        select?: Record<string, unknown>;
        include?: unknown;
      }>(prisma.infraNode.findMany);
      expect(arg.select).toBeDefined();
      expect(arg.select).not.toHaveProperty('specs');
      // A bare `include` would re-open the hole: Prisma returns EVERY scalar alongside the relation.
      expect(arg.include).toBeUndefined();
      // The asset enrichment must survive the switch to `select` (same one-query join, no N+1).
      expect(arg.select?.asset).toBeDefined();
    });

    it('still selects every OTHER wire field, so the projection cannot silently starve the list', async () => {
      prisma.infraNode.findMany.mockResolvedValue([]);

      await service.listNodes();

      const arg = firstArg<{ select: Record<string, unknown> }>(
        prisma.infraNode.findMany,
      );
      // The shared schema is the contract; `assetName`/`owners` are flattened from the asset relation
      // rather than selected as columns, so they are the only legitimate absences.
      const missing = Object.keys(InfraNodeListItemSchema.shape).filter(
        (field) =>
          field !== 'assetName' && field !== 'owners' && !arg.select[field],
      );
      expect(missing).toEqual([]);
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

  // ── Identity corroboration on the report path (ADR-0074 §3 amendment, #1141) ─

  describe('ingestReport — cloned machine-id detection', () => {
    /** A v2 report carrying the two burned-in facts the corroboration rule compares. */
    const reportFrom = (hostname: string, serial: string, mac: string) =>
      AgentReportSchema.parse({
        agentVersion: '2.0.0',
        reportingSource: 'agent:clone',
        externalId: 'machine-id-baked',
        reportedAt: '2026-07-31T12:00:00.000Z',
        host: {
          hostname,
          identifiers: [
            { kind: 'machine-id', value: 'baked' },
            { kind: 'serial', value: serial },
            { kind: 'mac', value: mac },
          ],
        },
      });

    /** What the `specs->'host'` sub-select returns for the node that already owns the key. */
    const storedHost = (
      hostname: string,
      identifiers?: Array<{ kind: string; value: string }>,
    ) => [{ host: { hostname, ...(identifiers ? { identifiers } : {}) } }];

    // `label` is part of the real select: the nudge names the node the operator already has, which is
    // the whole difference between an actionable warning and a cryptic one.
    const ORIGINAL = {
      id: 'node-1',
      assetId: null,
      ipAddressSource: 'AGENT',
      label: 'web-01',
    };

    it('NEVER splits a legacy node: no stored identifiers ⇒ the pre-#1141 refresh, and no nudge', async () => {
      // The load-bearing upgrade promise. Every row stored before contract v2 carries no
      // `identifiers[]`, so absence must read as "nothing to corroborate", never as "a different host".
      //
      // The `null` on the SECOND lookup is what makes this test bite. A blanket mock would hand the
      // collision branch the same owner row when it goes looking for the clone's own node, so a
      // wrongly-detected split would silently degenerate back into the refresh path and every
      // assertion below would still pass — the test would assert the promise without testing it.
      prisma.infraNode.findFirst
        .mockResolvedValueOnce(ORIGINAL) // the key's current owner
        .mockResolvedValueOnce(null); // only ever reached if the rule wrongly fires
      prisma.$queryRaw.mockResolvedValue(storedHost('web-01'));
      prisma.infraNode.update.mockResolvedValue({
        id: 'node-1',
        state: 'CONFIRMED',
      });
      // So that a regression fails on the assertion below rather than on a null dereference.
      prisma.infraNode.create.mockResolvedValue({
        id: 'node-2',
        state: 'PENDING',
      });

      const ack = await service.ingestReport(
        reportFrom('web-02', 'SN-BETA', 'aa:bb:cc:dd:ee:02'),
      );

      expect(prisma.infraNode.update).toHaveBeenCalledTimes(1);
      expect(prisma.infraNode.create).not.toHaveBeenCalled();
      expect(notifications.emit).not.toHaveBeenCalled();
      expect(ack).toEqual({
        nodeId: 'node-1',
        state: 'CONFIRMED',
        accepted: true,
      });
    });

    it('NEVER splits when the evidence still corroborates (same serial, swapped NIC, new name)', async () => {
      // Same reason as above: the second lookup must NOT hand back the owner row, or a rule that
      // wrongly widened "all three differ" into "any one differs" would still look like a refresh.
      prisma.infraNode.findFirst
        .mockResolvedValueOnce(ORIGINAL)
        .mockResolvedValueOnce(null);
      prisma.$queryRaw.mockResolvedValue(
        storedHost('web-01', [
          { kind: 'serial', value: 'SN-ALPHA' },
          { kind: 'mac', value: 'aa:bb:cc:dd:ee:01' },
        ]),
      );
      prisma.infraNode.update.mockResolvedValue({
        id: 'node-1',
        state: 'CONFIRMED',
      });
      prisma.infraNode.create.mockResolvedValue({
        id: 'node-2',
        state: 'PENDING',
      });

      await service.ingestReport(
        reportFrom('web-renamed', 'SN-ALPHA', 'aa:bb:cc:dd:ee:99'),
      );

      expect(prisma.infraNode.update).toHaveBeenCalledTimes(1);
      expect(prisma.infraNode.create).not.toHaveBeenCalled();
      expect(notifications.emit).not.toHaveBeenCalled();
    });

    it('a SECOND host on the same machine-id gets its OWN pending node, and the original is untouched', async () => {
      prisma.infraNode.findFirst
        .mockResolvedValueOnce(ORIGINAL) // the key's current owner
        .mockResolvedValueOnce(null); // the clone has no node of its own yet
      prisma.$queryRaw.mockResolvedValue(
        storedHost('web-01', [
          { kind: 'serial', value: 'SN-ALPHA' },
          { kind: 'mac', value: 'aa:bb:cc:dd:ee:01' },
        ]),
      );
      prisma.infraNode.create.mockResolvedValue({
        id: 'node-2',
        state: 'PENDING',
      });

      const ack = await service.ingestReport(
        reportFrom('web-02', 'SN-BETA', 'aa:bb:cc:dd:ee:02'),
        AGENT_SA,
      );

      // The clone gets a DETERMINISTIC key of its own — the partial-unique dedup index physically
      // forbids two live rows sharing one, and the clone must land on the same node every 15 minutes.
      const createArg = firstArg<{
        data: {
          externalId: string;
          reportingSource: string;
          state: string;
          label: string;
          specs: { identityConflict?: { peerNodeId?: string } };
        };
      }>(prisma.infraNode.create);
      expect(createArg.data.externalId).toBe('machine-id-baked#SN-BETA');
      expect(createArg.data.reportingSource).toBe('agent:clone');
      expect(createArg.data.state).toBe('PENDING');
      expect(createArg.data.label).toBe('web-02');
      expect(createArg.data.specs.identityConflict?.peerNodeId).toBe('node-1');

      // NOTHING is auto-merged and nothing is auto-split: the node that owns the key is not written to.
      expect(prisma.infraNode.update).not.toHaveBeenCalled();
      // It is a NEW row, so it is charged to the enrollment budget exactly like any other (#1134).
      expect(enrollment.assertWithinBudget).toHaveBeenCalledWith(AGENT_SA);

      // ONE nudge, naming the actual remedy — the only automatic action this whole change takes.
      expect(notifications.emit).toHaveBeenCalledTimes(1);
      const emitted = firstArg<{
        type: string;
        dedupeKey: string;
        severity: string;
        summary: string;
        metadata: Record<string, unknown>;
      }>(notifications.emit);
      expect(emitted.type).toBe('infra.identity_conflict');
      expect(emitted.dedupeKey).toBe('infra.identity_conflict:node-1:SN-BETA');
      expect(emitted.summary).toContain('systemd-firstboot');
      expect(emitted.metadata.peerNodeId).toBe('node-1');

      // The report is ACCEPTED — degrade and inform, never reject (the contract's whole posture).
      expect(ack).toEqual({
        nodeId: 'node-2',
        state: 'PENDING',
        accepted: true,
      });
    });

    it("the clone's NEXT report refreshes its own node and never re-nags", async () => {
      prisma.infraNode.findFirst
        .mockResolvedValueOnce(ORIGINAL)
        .mockResolvedValueOnce({
          id: 'node-2',
          assetId: null,
          ipAddressSource: 'AGENT',
        });
      prisma.$queryRaw.mockResolvedValue(
        storedHost('web-01', [
          { kind: 'serial', value: 'SN-ALPHA' },
          { kind: 'mac', value: 'aa:bb:cc:dd:ee:01' },
        ]),
      );
      prisma.infraNode.update.mockResolvedValue({
        id: 'node-2',
        state: 'PENDING',
      });

      const ack = await service.ingestReport(
        reportFrom('web-02', 'SN-BETA', 'aa:bb:cc:dd:ee:02'),
        AGENT_SA,
      );

      const updateArg = firstArg<{ where: { id: string } }>(
        prisma.infraNode.update,
      );
      expect(updateArg.where).toEqual({ id: 'node-2' });
      expect(prisma.infraNode.create).not.toHaveBeenCalled();
      // A known host adds no row, so it is never charged — and it never re-emits (#852 discipline).
      expect(enrollment.assertWithinBudget).not.toHaveBeenCalled();
      expect(notifications.emit).not.toHaveBeenCalled();
      expect(ack.nodeId).toBe('node-2');
    });

    it('THE MOTIVATING CASE: a golden-image clone that kept the template hostname still splits', async () => {
      // A baked machine-id comes with a baked HOSTNAME — that is what "cloned from a template" means.
      // The hypervisor still gives each guest its own SMBIOS serial and its own MACs, and those two
      // facts alone are the rule. The hostname is corroborating detail in the message, not a gate.
      prisma.infraNode.findFirst
        .mockResolvedValueOnce(ORIGINAL)
        .mockResolvedValueOnce(null);
      prisma.$queryRaw.mockResolvedValue(
        storedHost('web-01', [
          { kind: 'serial', value: 'SN-ALPHA' },
          { kind: 'mac', value: 'aa:bb:cc:dd:ee:01' },
        ]),
      );
      prisma.infraNode.create.mockResolvedValue({
        id: 'node-2',
        state: 'PENDING',
      });

      // Same hostname as the node that already owns the key — the case the first rule excused.
      await service.ingestReport(
        reportFrom('web-01', 'SN-BETA', 'aa:bb:cc:dd:ee:02'),
        AGENT_SA,
      );

      expect(prisma.infraNode.create).toHaveBeenCalledTimes(1);
      expect(prisma.infraNode.update).not.toHaveBeenCalled();
      // The shared hostname is REPORTED, since two hosts answering to one name is itself the
      // golden-image signature and the operator would otherwise read the same name twice and wonder.
      const emitted = firstArg<{ summary: string }>(notifications.emit);
      expect(emitted.summary).toContain('same hostname');
    });

    it('re-stamps identityConflict on every report, keeping the FIRST detection time', async () => {
      // The blob is rewritten wholesale on every check-in, so a marker written once would be gone
      // 15 minutes later — leaving the operator a notification pointing at a node that shows no
      // evidence of why. It is re-stamped for as long as the collision lasts (and only then).
      prisma.infraNode.findFirst
        .mockResolvedValueOnce(ORIGINAL)
        .mockResolvedValueOnce({
          id: 'node-2',
          assetId: null,
          ipAddressSource: 'AGENT',
        });
      prisma.$queryRaw
        // the peer's stored evidence …
        .mockResolvedValueOnce(
          storedHost('web-01', [
            { kind: 'serial', value: 'SN-ALPHA' },
            { kind: 'mac', value: 'aa:bb:cc:dd:ee:01' },
          ]),
        )
        // … then the clone's own marker, from a detection three weeks ago.
        .mockResolvedValueOnce([{ detectedAt: '2026-07-10T09:00:00.000Z' }]);
      prisma.infraNode.update.mockResolvedValue({
        id: 'node-2',
        state: 'PENDING',
      });

      await service.ingestReport(
        reportFrom('web-02', 'SN-BETA', 'aa:bb:cc:dd:ee:02'),
        AGENT_SA,
      );

      const updateArg = firstArg<{
        data: { specs: { identityConflict?: Record<string, unknown> } };
      }>(prisma.infraNode.update);
      expect(updateArg.data.specs.identityConflict).toEqual({
        reportedExternalId: 'machine-id-baked',
        peerNodeId: 'node-1',
        peerLabel: 'web-01',
        discriminator: 'SN-BETA',
        // Preserved, not reset: the marker also says how long the collision has been true.
        detectedAt: '2026-07-10T09:00:00.000Z',
      });
    });

    it('the collision CREATE survives the concurrent-report race (P2002 → refresh, #1012)', async () => {
      // The main ingest path has handled this race since #1012; the collision branch must too, or a
      // clone reporting from two processes 500s exactly when the operator most needs a clear signal.
      prisma.infraNode.findFirst
        .mockResolvedValueOnce(ORIGINAL) // the key's current owner
        .mockResolvedValueOnce(null) // no node of its own yet …
        .mockResolvedValueOnce({
          // … until the racing report inserted one between the lookup and the create.
          id: 'node-2',
          assetId: null,
          ipAddressSource: 'AGENT',
        });
      prisma.$queryRaw.mockResolvedValue(
        storedHost('web-01', [
          { kind: 'serial', value: 'SN-ALPHA' },
          { kind: 'mac', value: 'aa:bb:cc:dd:ee:01' },
        ]),
      );
      prisma.infraNode.create.mockRejectedValue(new KnownError('P2002'));
      prisma.infraNode.update.mockResolvedValue({
        id: 'node-2',
        state: 'PENDING',
      });

      const ack = await service.ingestReport(
        reportFrom('web-02', 'SN-BETA', 'aa:bb:cc:dd:ee:02'),
        AGENT_SA,
      );

      // Idempotent (ack), never a 500 — and the marker still lands, on the row the winner created.
      expect(ack).toEqual({
        nodeId: 'node-2',
        state: 'PENDING',
        accepted: true,
      });
      const updateArg = firstArg<{
        where: { id: string };
        data: { specs: { identityConflict?: { peerNodeId?: string } } };
      }>(prisma.infraNode.update);
      expect(updateArg.where).toEqual({ id: 'node-2' });
      expect(updateArg.data.specs.identityConflict?.peerNodeId).toBe('node-1');
      // The winning report already nudged, and the dedupe key is the same — the loser stays quiet.
      expect(notifications.emit).not.toHaveBeenCalled();
    });

    it('rethrows a P2002 the collision branch cannot resolve, rather than looping', async () => {
      prisma.infraNode.findFirst
        .mockResolvedValueOnce(ORIGINAL)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null); // the raced row is not there (archived in the same instant)
      prisma.$queryRaw.mockResolvedValue(
        storedHost('web-01', [
          { kind: 'serial', value: 'SN-ALPHA' },
          { kind: 'mac', value: 'aa:bb:cc:dd:ee:01' },
        ]),
      );
      prisma.infraNode.create.mockRejectedValue(new KnownError('P2002'));

      await expect(
        service.ingestReport(
          reportFrom('web-02', 'SN-BETA', 'aa:bb:cc:dd:ee:02'),
          AGENT_SA,
        ),
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  // ── Re-key / merge-into: the HUMAN half of identity reconciliation (#1141) ───

  describe('mergeNodeInto', () => {
    const SOURCE = {
      id: 'node-dup',
      label: 'srv-app-04',
      reportingSource: 'agent:clone',
      externalId: 'machine-id-new',
      lastReportedAt: new Date('2026-07-31T12:00:00.000Z'),
      agentVersion: '2.0.0',
      status: 'ONLINE',
      ipAddress: '10.0.0.9',
      specs: { host: { hostname: 'srv-app-04' }, reportedAt: 'now' },
      assetId: null,
      deletedAt: null,
    };
    const TARGET = {
      id: 'node-keep',
      label: 'srv-app-04 (prod)',
      state: 'CONFIRMED',
      reportingSource: 'agent:old',
      externalId: 'machine-id-old',
      ipAddressSource: 'AGENT',
      specs: { rack: 'B12' },
      assetId: 'asset-1',
      deletedAt: null,
    };

    it('transplants the agent identity onto the target and archives the duplicate', async () => {
      prisma.infraNode.findFirst
        .mockResolvedValueOnce(SOURCE)
        .mockResolvedValueOnce(TARGET)
        // The search re-projection and getNodeDetail both re-read the target after the merge.
        .mockResolvedValue({ ...TARGET, externalId: 'machine-id-new' });
      prisma.infraNode.findMany.mockResolvedValue([]);
      prisma.infraEdge.findMany.mockResolvedValue([]);
      prisma.asset.findFirst.mockResolvedValue({ name: 'app-04' });

      await service.mergeNodeInto('node-dup', 'node-keep', HUMAN);

      // Both writes ride ONE transaction: the source must lose the key before the target can take it,
      // or the partial-unique dedup index refuses the second write.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const [archive, adopt] = txNode.update.mock.calls as Array<
        [{ where: { id: string }; data: Record<string, unknown> }]
      >;
      expect(archive[0].where).toEqual({ id: 'node-dup' });
      expect(archive[0].data.deletedAt).toBeInstanceOf(Date);
      // The archived row IS the audit trail — it can never be overwritten by another report.
      expect(archive[0].data.specs).toMatchObject({
        _infraMergedInto: { nodeId: 'node-keep', byUserId: 'u-1' },
      });

      expect(adopt[0].where).toEqual({ id: 'node-keep' });
      expect(adopt[0].data.externalId).toBe('machine-id-new');
      expect(adopt[0].data.reportingSource).toBe('agent:clone');
      expect(adopt[0].data.source).toBe('AGENT');
      expect(adopt[0].data.lastReportedAt).toEqual(SOURCE.lastReportedAt);
      expect(adopt[0].data.agentVersion).toBe('2.0.0');
      // Human curation on the target survives — the merge moves IDENTITY, not curation.
      expect(adopt[0].data).not.toHaveProperty('label');
      expect(adopt[0].data).not.toHaveProperty('state');
      expect(adopt[0].data).not.toHaveProperty('assetId');
      // The target's own specs keys survive; the agent-owned facts come from the duplicate.
      expect(adopt[0].data.specs).toMatchObject({
        rack: 'B12',
        host: { hostname: 'srv-app-04' },
      });

      // Search: the archived duplicate leaves the index, the adopting node is re-projected.
      expect(search.remove).toHaveBeenCalledWith('infra', 'node-dup');
      expect(search.upsert).toHaveBeenCalled();
    });

    it('clears the reporting key off the archived duplicate so it can be RESTORED', async () => {
      // Soft delete is reversible in this codebase (ADR-0006). Leaving `reportingSource`/`externalId`
      // on the archived row while the same pair lives on the target means restoring it violates the
      // partial-unique dedup index and 500s — a soft delete that cannot be undone.
      prisma.infraNode.findFirst
        .mockResolvedValueOnce(SOURCE)
        .mockResolvedValueOnce(TARGET)
        .mockResolvedValue({ ...TARGET, externalId: 'machine-id-new' });
      prisma.infraNode.findMany.mockResolvedValue([]);
      prisma.infraEdge.findMany.mockResolvedValue([]);
      prisma.asset.findFirst.mockResolvedValue({ name: 'app-04' });

      await service.mergeNodeInto('node-dup', 'node-keep', HUMAN);

      const [archive] = txNode.update.mock.calls as Array<
        [{ data: Record<string, unknown> }]
      >;
      expect(archive[0].data.reportingSource).toBeNull();
      expect(archive[0].data.externalId).toBeNull();
      // The key it carried is not lost — the merge marker is where it now lives.
      expect(archive[0].data.specs).toMatchObject({
        _infraMergedInto: {
          externalId: 'machine-id-new',
          reportingSource: 'agent:clone',
        },
      });
    });

    it('records the target reporting key a merge DESTROYS', async () => {
      // The target may already report through an agent of its own (the re-image case always does).
      // That key is overwritten and is then owned by nobody, so the merge has to say what it replaced
      // — on the archived row, the only part of a merge a later report can never overwrite.
      prisma.infraNode.findFirst
        .mockResolvedValueOnce(SOURCE)
        .mockResolvedValueOnce(TARGET)
        .mockResolvedValue({ ...TARGET, externalId: 'machine-id-new' });
      prisma.infraNode.findMany.mockResolvedValue([]);
      prisma.infraEdge.findMany.mockResolvedValue([]);
      prisma.asset.findFirst.mockResolvedValue({ name: 'app-04' });

      await service.mergeNodeInto('node-dup', 'node-keep', HUMAN);

      const [archive] = txNode.update.mock.calls as Array<
        [{ data: { specs: Record<string, unknown> } }]
      >;
      expect(archive[0].data.specs).toMatchObject({
        _infraMergedInto: {
          replacedTargetKey: {
            reportingSource: 'agent:old',
            externalId: 'machine-id-old',
          },
        },
      });
    });

    it('records nothing replaced when the target had no reporting key of its own', async () => {
      prisma.infraNode.findFirst
        .mockResolvedValueOnce(SOURCE)
        .mockResolvedValueOnce({
          ...TARGET,
          reportingSource: null,
          externalId: null,
        })
        .mockResolvedValue({ ...TARGET, externalId: 'machine-id-new' });
      prisma.infraNode.findMany.mockResolvedValue([]);
      prisma.infraEdge.findMany.mockResolvedValue([]);
      prisma.asset.findFirst.mockResolvedValue({ name: 'app-04' });

      await service.mergeNodeInto('node-dup', 'node-keep', HUMAN);

      const [archive] = txNode.update.mock.calls as Array<
        [{ data: { specs: { _infraMergedInto: Record<string, unknown> } } }]
      >;
      expect(archive[0].data.specs._infraMergedInto).not.toHaveProperty(
        'replacedTargetKey',
      );
    });

    it('never clobbers a MANUAL ip on the target, but seeds an AGENT one', async () => {
      prisma.infraNode.findFirst
        .mockResolvedValueOnce(SOURCE)
        .mockResolvedValueOnce({ ...TARGET, ipAddressSource: 'MANUAL' })
        .mockResolvedValue(TARGET);
      prisma.infraNode.findMany.mockResolvedValue([]);
      prisma.infraEdge.findMany.mockResolvedValue([]);
      prisma.asset.findFirst.mockResolvedValue({ name: 'app-04' });

      await service.mergeNodeInto('node-dup', 'node-keep', HUMAN);

      const [, adopt] = txNode.update.mock.calls as Array<
        [{ data: Record<string, unknown> }]
      >;
      expect(adopt[0].data).not.toHaveProperty('ipAddress');
    });

    it('refuses to merge a node into itself', async () => {
      await expect(
        service.mergeNodeInto('node-dup', 'node-dup', HUMAN),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses a source that carries no agent identity to transplant', async () => {
      prisma.infraNode.findFirst
        .mockResolvedValueOnce({ ...SOURCE, externalId: null })
        .mockResolvedValueOnce(TARGET);

      await expect(
        service.mergeNodeInto('node-dup', 'node-keep', HUMAN),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('404s on a missing / soft-deleted endpoint', async () => {
      prisma.infraNode.findFirst.mockResolvedValue(null);
      await expect(
        service.mergeNodeInto('nope', 'node-keep', HUMAN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── Re-image adoption hints (#1141) ─────────────────────────────────────────

  describe('findIdentityMatches', () => {
    it('pairs a fresh proposal with the node that shares its burned-in serial', async () => {
      prisma.infraNode.findFirst.mockResolvedValue({ id: 'node-new' });
      const host = (serial: string, mac: string) => [
        {
          host: {
            hostname: 'srv-app-04',
            identifiers: [
              { kind: 'serial', value: serial },
              { kind: 'mac', value: mac },
            ],
          },
        },
      ];
      prisma.$queryRaw
        // the subject's own evidence …
        .mockResolvedValueOnce(host('SN-ALPHA', 'aa:bb:cc:dd:ee:01'))
        // … then the candidate's, re-read so `matchedOn` names the fact that actually matched.
        .mockResolvedValueOnce(host('SN-ALPHA', 'ff:ff:ff:ff:ff:fe'));
      prisma.infraNode.findMany.mockResolvedValue([
        {
          id: 'node-old',
          label: 'srv-app-04',
          kind: 'PHYSICAL_HOST',
          status: 'OFFLINE',
          state: 'CONFIRMED',
        },
      ]);

      const matches = await service.findIdentityMatches('node-new');

      expect(matches).toEqual([
        {
          id: 'node-old',
          label: 'srv-app-04',
          kind: 'PHYSICAL_HOST',
          status: 'OFFLINE',
          state: 'CONFIRMED',
          matchedOn: 'serial',
          value: 'SN-ALPHA',
        },
      ]);
    });

    it('a node with no stored evidence queries nothing and matches nothing', async () => {
      prisma.infraNode.findFirst.mockResolvedValue({ id: 'node-legacy' });
      prisma.$queryRaw.mockResolvedValue([{ host: { hostname: 'web-01' } }]);

      expect(await service.findIdentityMatches('node-legacy')).toEqual([]);
      expect(prisma.infraNode.findMany).not.toHaveBeenCalled();
    });
  });
});
