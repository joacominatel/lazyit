import { Test } from '@nestjs/testing';
import { AGENT_FLEET_IDENTITY_LIMIT } from '@lazyit/shared';
import { AgentFleetService } from './agent-fleet.service';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';

// The service touches two models and one raw projection; the generated client is stubbed down to the
// two symbols the module graph needs at import time (`Prisma.sql` is used to build the projection).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    // The documented array-binding helper: every id becomes its own bound parameter.
    join: (values: unknown[]) => ({ joined: values }),
  },
}));

type Mock = jest.Mock;

/** One row as the scalar `findMany` returns it; each test overrides only what it is about. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: 'n-1',
    label: 'web-01',
    kind: 'PHYSICAL_HOST',
    status: 'ONLINE',
    state: 'CONFIRMED',
    ipAddress: '10.0.0.5',
    agentVersion: 'v1.4.0',
    chassis: null,
    reportingSource: 'agent:abc',
    lastReportedAt: new Date('2026-08-04T10:00:00.000Z'),
    asset: null,
    ...over,
  };
}

/**
 * Principal fixtures for the credential-inventory gate. Only the `settings:manage` RESOLUTION drives
 * it for a human (mocked via `hasAll`), so the role here is illustrative; a service account is
 * authorized straight off its direct grants, so its set is the real input.
 */
const ADMIN_PRINCIPAL = { kind: 'human', user: { role: 'ADMIN' } } as never;
const VIEWER_PRINCIPAL = { kind: 'human', user: { role: 'VIEWER' } } as never;
const servicePrincipal = (...permissions: string[]) =>
  ({
    kind: 'service',
    serviceAccount: { id: 'sa-caller' },
    permissions: new Set(permissions),
  }) as never;

describe('AgentFleetService (ADR-0094 §4, #1206)', () => {
  let service: AgentFleetService;
  let nodeFindMany: Mock;
  let saFindMany: Mock;
  let saCount: Mock;
  let queryRaw: Mock;
  let hasAll: Mock;

  const ORIGINAL_APP_VERSION = process.env.APP_VERSION;

  async function build(serverVersion = 'v1.10.0'): Promise<AgentFleetService> {
    process.env.APP_VERSION = serverVersion;
    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentFleetService,
        {
          provide: PrismaService,
          useValue: {
            infraNode: { findMany: nodeFindMany },
            serviceAccount: { findMany: saFindMany, count: saCount },
            $queryRaw: queryRaw,
          },
        },
        // The DB-first resolver (ADR-0046), mocked. It answers exactly one question here: does the
        // caller hold `settings:manage`? Default false — the ungated case is the one that matters.
        { provide: PermissionResolverService, useValue: { hasAll } },
      ],
    }).compile();
    return moduleRef.get(AgentFleetService);
  }

  beforeEach(() => {
    nodeFindMany = jest.fn().mockResolvedValue([]);
    saFindMany = jest.fn().mockResolvedValue([]);
    saCount = jest.fn().mockResolvedValue(0);
    queryRaw = jest.fn().mockResolvedValue([]);
    hasAll = jest.fn().mockResolvedValue(false);
  });

  afterAll(() => {
    if (ORIGINAL_APP_VERSION === undefined) delete process.env.APP_VERSION;
    else process.env.APP_VERSION = ORIGINAL_APP_VERSION;
  });

  /** Type the loosely-typed jest mock call args so the assertions stay type-safe (no `any` access). */
  type FindManyArgs = {
    where?: Record<string, unknown>;
    orderBy?: unknown;
    select: Record<string, unknown>;
  };
  const nodeArgs = (): FindManyArgs =>
    (nodeFindMany.mock.calls[0] as unknown[])[0] as FindManyArgs;
  const saArgs = (): FindManyArgs =>
    (saFindMany.mock.calls[0] as unknown[])[0] as FindManyArgs;
  const saCountArgs = (): { where: Record<string, unknown> } =>
    (saCount.mock.calls[0] as unknown[])[0] as {
      where: Record<string, unknown>;
    };
  const rawArgs = (): { values: unknown[] } =>
    (queryRaw.mock.calls[0] as unknown[])[0] as { values: unknown[] };

  // ── what the read is scoped to ─────────────────────────────────────────────

  describe('scope', () => {
    it('reads AGENT hosts only, and never a CONTAINER child', async () => {
      service = await build();

      await service.getFleet();

      // A container is stamped with its HOST's agentVersion on every report (#1139) — counting one
      // would inflate every bucket by however many containers a host happens to run.
      expect(nodeArgs().where).toMatchObject({
        source: 'AGENT',
        kind: { not: 'CONTAINER' },
      });
    });

    it('never selects `specs` — the blob stays in the database (#1135)', async () => {
      service = await build();

      await service.getFleet();

      expect(nodeArgs().select).not.toHaveProperty('specs');
    });

    it('skips the jsonb projection entirely when there are no nodes', async () => {
      service = await build();

      const view = await service.getFleet();

      expect(queryRaw).not.toHaveBeenCalled();
      expect(view.nodes).toEqual([]);
      expect(view.summary.total).toBe(0);
    });

    it('carries the server version the buckets were computed against', async () => {
      service = await build('v2.3.4');

      expect((await service.getFleet()).serverVersion).toBe('v2.3.4');
    });
  });

  // ── the buckets (ADR-0094 §3) ──────────────────────────────────────────────

  describe('the version buckets', () => {
    it('buckets each host against the running instance and tallies the distribution', async () => {
      nodeFindMany.mockResolvedValue([
        row({ id: 'n-major', agentVersion: 'v0.9.0' }),
        row({ id: 'n-behind', agentVersion: 'v1.9.0' }),
        row({ id: 'n-current', agentVersion: 'v1.10.0' }),
        row({ id: 'n-dev', agentVersion: 'dev' }),
        row({ id: 'n-null', agentVersion: null }),
      ]);
      service = await build('v1.10.0');

      const view = await service.getFleet();

      expect(
        Object.fromEntries(view.nodes.map((n) => [n.id, n.versionBucket])),
      ).toEqual({
        'n-major': 'majorBehind',
        'n-behind': 'behind',
        'n-current': 'current',
        'n-dev': 'unknown',
        'n-null': 'unknown',
      });
      expect(view.summary).toMatchObject({
        total: 5,
        majorBehind: 1,
        behind: 1,
        current: 1,
        unknown: 2,
        behindTotal: 2,
      });
    });

    it('a `dev` INSTANCE reads as an entirely unknown fleet — the #1203 state, told honestly', async () => {
      nodeFindMany.mockResolvedValue([
        row({ id: 'a', agentVersion: 'v1.0.0' }),
        row({ id: 'b', agentVersion: 'v2.0.0' }),
      ]);
      service = await build('dev');

      const view = await service.getFleet();

      // Fail-soft is not loosened for this: "we cannot compare" is never "behind".
      expect(view.summary).toMatchObject({ unknown: 2, behindTotal: 0 });
    });
  });

  // ── the `specs` projection (ADR-0094 §5 / the ADR-0090 read-field mold) ─────

  describe('the osFamily + diagnostics projection', () => {
    it('projects the OS family onto the row without carrying the blob', async () => {
      nodeFindMany.mockResolvedValue([row({ id: 'n-1' })]);
      queryRaw.mockResolvedValue([
        { id: 'n-1', osFamily: 'windows', diagnostics: null },
      ]);
      service = await build();

      const view = await service.getFleet();

      expect(view.nodes[0].osFamily).toBe('windows');
      // Only the ids the extension-scoped findMany returned are ever asked about, and they travel as
      // bound parameters — nothing about this query is concatenated.
      expect(rawArgs().values).toEqual([{ joined: ['n-1'] }]);
    });

    it('drops an unrecognised family rather than guessing — the UI must show BOTH commands', async () => {
      nodeFindMany.mockResolvedValue([row({ id: 'n-1' })]);
      queryRaw.mockResolvedValue([
        { id: 'n-1', osFamily: 'plan9', diagnostics: null },
      ]);
      service = await build();

      expect((await service.getFleet()).nodes[0].osFamily).toBeNull();
    });

    it('a node with no projected row at all still produces a row (a manual/legacy blob)', async () => {
      nodeFindMany.mockResolvedValue([row({ id: 'n-1' })]);
      queryRaw.mockResolvedValue([]);
      service = await build();

      const view = await service.getFleet();

      expect(view.nodes[0]).toMatchObject({
        osFamily: null,
        diagnostics: null,
        degraded: false,
      });
    });

    it('reads the collector diagnostics and flags the row degraded', async () => {
      nodeFindMany.mockResolvedValue([row({ id: 'n-1' })]);
      queryRaw.mockResolvedValue([
        {
          id: 'n-1',
          osFamily: 'linux',
          diagnostics: {
            privileged: false,
            warnings: ['dmi: permission denied'],
            durationMs: 1200,
          },
        },
      ]);
      service = await build();

      const view = await service.getFleet();

      expect(view.nodes[0].diagnostics).toEqual({
        privileged: false,
        warnings: ['dmi: permission denied'],
      });
      expect(view.nodes[0].degraded).toBe(true);
      expect(view.summary.degraded).toBe(1);
    });

    it('a clean privileged run is not degraded', async () => {
      nodeFindMany.mockResolvedValue([row({ id: 'n-1' })]);
      queryRaw.mockResolvedValue([
        {
          id: 'n-1',
          osFamily: 'linux',
          diagnostics: { privileged: true, warnings: [] },
        },
      ]);
      service = await build();

      const view = await service.getFleet();

      expect(view.nodes[0].degraded).toBe(false);
    });

    it('a pre-#1138 agent that says nothing about privilege is NOT degraded', async () => {
      nodeFindMany.mockResolvedValue([row({ id: 'n-1' })]);
      queryRaw.mockResolvedValue([
        { id: 'n-1', osFamily: 'linux', diagnostics: { durationMs: 900 } },
      ]);
      service = await build();

      const view = await service.getFleet();

      // Silence is not evidence: collapsing "did not say" into "unprivileged" would mark every
      // pre-contract-v2 agent degraded, forever.
      expect(view.nodes[0].diagnostics).toBeNull();
      expect(view.nodes[0].degraded).toBe(false);
    });

    it('tolerates a junk diagnostics value instead of failing the whole view', async () => {
      nodeFindMany.mockResolvedValue([row({ id: 'n-1' })]);
      queryRaw.mockResolvedValue([
        { id: 'n-1', osFamily: null, diagnostics: 'not an object' },
      ]);
      service = await build();

      expect((await service.getFleet()).nodes[0].diagnostics).toBeNull();
    });

    it('drops non-string warnings rather than stringifying them', async () => {
      nodeFindMany.mockResolvedValue([row({ id: 'n-1' })]);
      queryRaw.mockResolvedValue([
        {
          id: 'n-1',
          osFamily: 'linux',
          diagnostics: { warnings: ['ok', 42, null] },
        },
      ]);
      service = await build();

      expect((await service.getFleet()).nodes[0].diagnostics).toEqual({
        privileged: null,
        warnings: ['ok'],
      });
    });
  });

  // ── liveness + the asset gate ──────────────────────────────────────────────

  describe('the row', () => {
    it('counts OFFLINE and never-reported hosts as not reporting', async () => {
      nodeFindMany.mockResolvedValue([
        row({ id: 'a', status: 'OFFLINE' }),
        row({ id: 'b', lastReportedAt: null }),
        row({ id: 'c' }),
      ]);
      service = await build();

      expect((await service.getFleet()).summary.notReporting).toBe(2);
    });

    it('never leaks a soft-deleted asset’s name', async () => {
      nodeFindMany.mockResolvedValue([
        row({
          id: 'a',
          asset: { name: 'Live laptop', deletedAt: null },
        }),
        row({
          id: 'b',
          asset: { name: 'Archived laptop', deletedAt: new Date() },
        }),
      ]);
      service = await build();

      const view = await service.getFleet();

      expect(view.nodes[0].assetName).toBe('Live laptop');
      expect(view.nodes[1].assetName).toBeNull();
    });

    it('flags a host still sitting in the PENDING review tray', async () => {
      nodeFindMany.mockResolvedValue([
        row({ id: 'a', state: 'PENDING' }),
        row({ id: 'b', state: 'CONFIRMED' }),
      ]);
      service = await build();

      const view = await service.getFleet();

      expect(view.nodes.map((n) => n.pending)).toEqual([true, false]);
    });

    it('degrades an unrecognised chassis to no signal (ADR-0093)', async () => {
      nodeFindMany.mockResolvedValue([
        row({ id: 'a', chassis: 'laptop' }),
        row({ id: 'b', chassis: 'hovercraft' }),
      ]);
      service = await build();

      const view = await service.getFleet();

      expect(view.nodes.map((n) => n.chassis)).toEqual(['laptop', null]);
    });

    it('serialises timestamps as ISO strings', async () => {
      nodeFindMany.mockResolvedValue([row({ id: 'a' })]);
      service = await build();

      expect((await service.getFleet()).nodes[0].lastReportedAt).toBe(
        '2026-08-04T10:00:00.000Z',
      );
    });
  });

  // ── the agent credentials (ADR-0094 §4 liveness, the other half) ───────────

  describe('agent identities', () => {
    /** Two live credentials — one never used, one that has authenticated. */
    const TWO_IDENTITIES = [
      {
        id: 'sa-1',
        name: 'agent-db-07',
        isActive: true,
        lastUsedAt: null,
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      },
      {
        id: 'sa-2',
        name: 'agent-web-01',
        isActive: true,
        lastUsedAt: new Date('2026-08-04T09:00:00.000Z'),
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      },
    ];

    it('lists live service accounts holding infra:report, never-used first', async () => {
      saFindMany.mockResolvedValue(TWO_IDENTITIES);
      saCount.mockResolvedValue(1);
      hasAll.mockResolvedValue(true);
      service = await build();

      const view = await service.getFleet(ADMIN_PRINCIPAL);

      const args = saArgs();
      expect(args.where).toMatchObject({
        permissions: { some: { permission: 'infra:report' } },
      });
      expect(args.orderBy).toEqual([
        { lastUsedAt: { sort: 'asc', nulls: 'first' } },
        { createdAt: 'asc' },
      ]);
      // A credential read that never touches the secret, its hash, or even its display prefix.
      expect(args.select).not.toHaveProperty('tokenHash');
      expect(args.select).not.toHaveProperty('tokenPrefix');

      expect(view.identities).toEqual([
        {
          id: 'sa-1',
          name: 'agent-db-07',
          isActive: true,
          lastUsedAt: null,
          createdAt: '2026-07-01T00:00:00.000Z',
        },
        {
          id: 'sa-2',
          name: 'agent-web-01',
          isActive: true,
          lastUsedAt: '2026-08-04T09:00:00.000Z',
          createdAt: '2026-06-01T00:00:00.000Z',
        },
      ]);
    });

    // ── the never-used count is not derived from the capped list ─────────────

    it('counts never-used credentials with an unbounded count over the SAME predicate', async () => {
      saFindMany.mockResolvedValue(TWO_IDENTITIES);
      saCount.mockResolvedValue(1);
      hasAll.mockResolvedValue(true);
      service = await build();

      const view = await service.getFleet(ADMIN_PRINCIPAL);

      // Same population as the list, narrowed to the never-used ones — one predicate, two queries.
      expect(saCountArgs().where).toEqual({
        permissions: { some: { permission: 'infra:report' } },
        lastUsedAt: null,
      });
      // The actionable count: a token minted for a host that never checked in leaves no node behind,
      // so this is the only place that failure is visible.
      expect(view.identitiesNeverUsed).toBe(1);
    });

    it('reports the TRUTH past the identity cap, not the cap itself', async () => {
      // The list is capped, and the surface renders the count as an absolute ("N agent tokens have
      // never been used"). Tallying the truncated array would clamp 512 down to 200 and read as fact.
      saFindMany.mockResolvedValue(
        Array.from({ length: AGENT_FLEET_IDENTITY_LIMIT }, (_, i) => ({
          id: `sa-${i}`,
          name: `agent-${i}`,
          isActive: true,
          lastUsedAt: null,
          createdAt: new Date('2026-07-01T00:00:00.000Z'),
        })),
      );
      saCount.mockResolvedValue(512);
      hasAll.mockResolvedValue(true);
      service = await build();

      const view = await service.getFleet(ADMIN_PRINCIPAL);

      expect(view.identities).toHaveLength(AGENT_FLEET_IDENTITY_LIMIT);
      expect(view.identitiesNeverUsed).toBe(512);
    });
  });

  // ── the credential inventory is gated a SECOND time (settings:manage) ──────
  //
  // `infra:read` — the route's gate — reaches MEMBER *and* VIEWER in the default seed, while every
  // other surface that reads service accounts is `settings:manage` (ADR-0048). So the block is gated
  // again in app code, and its absence is a partial view, never a 403 on the whole read.

  describe('the credential inventory gate', () => {
    beforeEach(() => {
      saFindMany.mockResolvedValue([
        {
          id: 'sa-1',
          name: 'agent-db-07',
          isActive: true,
          lastUsedAt: null,
          createdAt: new Date('2026-07-01T00:00:00.000Z'),
        },
      ]);
      saCount.mockResolvedValue(1);
      nodeFindMany.mockResolvedValue([row({ id: 'n-1' })]);
    });

    /** No identity data at all — not the keys, and not a single value from the credential table. */
    function expectNoIdentityData(view: unknown): void {
      expect(view).not.toHaveProperty('identities');
      expect(view).not.toHaveProperty('identitiesNeverUsed');
      // Belt and braces: nothing from the credential row may appear ANYWHERE in the payload.
      expect(JSON.stringify(view)).not.toContain('agent-db-07');
      expect(JSON.stringify(view)).not.toContain('sa-1');
      // And the table was never even read for it (the #554 "never fetched" posture).
      expect(saFindMany).not.toHaveBeenCalled();
      expect(saCount).not.toHaveBeenCalled();
    }

    it('omits it entirely for a human WITHOUT settings:manage, and still returns the fleet', async () => {
      hasAll.mockResolvedValue(false);
      service = await build();

      const view = await service.getFleet(VIEWER_PRINCIPAL);

      expect(hasAll).toHaveBeenCalledWith('VIEWER', ['settings:manage']);
      expectNoIdentityData(view);
      // The point of omitting rather than 403-ing: the table itself IS `infra:read` material.
      expect(view.nodes).toHaveLength(1);
      expect(view.summary.total).toBe(1);
    });

    it('includes it for a human WITH settings:manage', async () => {
      hasAll.mockResolvedValue(true);
      service = await build();

      const view = await service.getFleet(ADMIN_PRINCIPAL);

      expect(hasAll).toHaveBeenCalledWith('ADMIN', ['settings:manage']);
      expect(view.identities).toHaveLength(1);
      expect(view.identitiesNeverUsed).toBe(1);
    });

    it('omits it for a service account that only holds infra:read', async () => {
      service = await build();

      const view = await service.getFleet(servicePrincipal('infra:read'));

      // A service account is authorized off its DIRECT grants, never a role — the resolver is not
      // consulted for it at all (INV-SA-3: it is never ADMIN-equivalent).
      expect(hasAll).not.toHaveBeenCalled();
      expectNoIdentityData(view);
    });

    it('includes it for a service account that directly holds settings:manage', async () => {
      service = await build();

      const view = await service.getFleet(
        servicePrincipal('infra:read', 'settings:manage'),
      );

      expect(view.identities).toHaveLength(1);
    });

    it('omits it with NO principal at all — fail closed', async () => {
      service = await build();

      expectNoIdentityData(await service.getFleet());
      expect(hasAll).not.toHaveBeenCalled();
    });
  });

  // ── the email aggregate (ADR-0094 §Decisions resolved 1) ───────────────────

  describe('countAgentsMajorBehind — the one line on the update email', () => {
    it('counts only the MAJOR tier, never MINOR/PATCH drift', async () => {
      nodeFindMany.mockResolvedValue([
        { agentVersion: 'v0.9.0' },
        { agentVersion: 'v1.0.0' },
        { agentVersion: 'v2.0.0' }, // behind, but not a MAJOR — an email is an interruption
        { agentVersion: 'v2.1.0' },
      ]);
      service = await build('v2.1.0');

      expect(await service.countAgentsMajorBehind()).toBe(2);
    });

    it('counts zero on an unstamped fleet, so the email simply gains no line', async () => {
      nodeFindMany.mockResolvedValue([
        { agentVersion: 'dev' },
        { agentVersion: 'nightly' },
      ]);
      service = await build('v2.0.0');

      expect(await service.countAgentsMajorBehind()).toBe(0);
    });

    it('never reads `specs` or a credential — it is a scalar count on a mail path', async () => {
      service = await build();

      await service.countAgentsMajorBehind();

      expect(nodeArgs().select).toEqual({ agentVersion: true });
      expect(queryRaw).not.toHaveBeenCalled();
      expect(saFindMany).not.toHaveBeenCalled();
      expect(saCount).not.toHaveBeenCalled();
    });
  });
});
