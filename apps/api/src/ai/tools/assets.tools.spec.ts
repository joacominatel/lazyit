import {
  AiActionPreviewSchema,
  AiToolResultSchema,
  type AiToolResult,
} from '@lazyit/shared';

jest.mock('../../../generated/prisma/client', () => {
  const enums: Record<string, unknown> = jest.requireActual(
    '../../../generated/prisma/enums',
  );
  const inert: unknown = new Proxy(function inert() {}, {
    get: (_target, prop) => (prop === Symbol.toPrimitive ? () => '' : inert),
    apply: () => inert,
    construct: () => inert as object,
  });
  return { ...enums, $Enums: enums, PrismaClient: class {}, Prisma: inert };
});
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
}));

import type { AiPendingAction } from '../core/pending-action';
import {
  A,
  ACTORS,
  ASSIGN,
  ID,
  INJECTION,
  L,
  M,
  T0,
  actor,
  ai,
  assetsService,
  cid,
  assignmentsService,
  bootHarness,
  ctx,
  events,
  historyRows,
  matrix,
  mcp,
  resetAll,
  state,
  touch,
  viaDispatch,
  viaNetwork,
  type Harness,
  type RouteCase,
} from './asset-tools.harness-spec';

type Row = Record<string, unknown>;
const ANY_STRING = expect.any(String) as unknown;
const WRAPPED = `<untrusted_content>${INJECTION}</untrusted_content>`;

/** Every route the assets tools bind, as HTTP requests and as dispatch shapes (ok / 400 / 403 / 404). */
const ROUTES: RouteCase[] = [
  {
    controller: 'assets',
    method: 'findAll',
    http: 'get',
    url: '/assets?q=LT&limit=20',
    shape: { query: { q: 'LT', limit: '20' } },
  },
  {
    controller: 'assets',
    method: 'findAll',
    http: 'get',
    url: '/assets?status=BROKEN',
    shape: { query: { status: 'BROKEN' } },
  },
  {
    controller: 'assets',
    method: 'findAll',
    http: 'get',
    url: '/assets?deleted=only',
    shape: { query: { deleted: 'only' } },
  },
  {
    controller: 'assets',
    method: 'findMine',
    http: 'get',
    url: '/assets/mine',
    shape: {},
  },
  {
    controller: 'assets',
    method: 'findOne',
    http: 'get',
    url: `/assets/${A.laptop}`,
    shape: { params: { id: A.laptop } },
  },
  {
    controller: 'assets',
    method: 'findOne',
    http: 'get',
    url: `/assets/${A.missing}`,
    shape: { params: { id: A.missing } },
  },
  {
    controller: 'assets',
    method: 'findAssignments',
    http: 'get',
    url: `/assets/${A.laptop}/assignments?activeOnly=false`,
    shape: { params: { id: A.laptop }, query: { activeOnly: 'false' } },
  },
  {
    controller: 'assets',
    method: 'findHistory',
    http: 'get',
    url: `/assets/${A.laptop}/history?limit=500`,
    shape: { params: { id: A.laptop }, query: { limit: '500' } },
  },
  {
    controller: 'assets',
    method: 'findArticles',
    http: 'get',
    url: `/assets/${A.laptop}/articles`,
    shape: { params: { id: A.laptop } },
  },
  {
    controller: 'assets',
    method: 'create',
    http: 'post',
    url: '/assets',
    shape: { body: { name: 'New', status: 'IN_STORAGE' } },
  },
  {
    controller: 'assets',
    method: 'create',
    http: 'post',
    url: '/assets',
    shape: { body: { name: '', status: 'NOPE' } },
  },
  {
    controller: 'assets',
    method: 'update',
    http: 'patch',
    url: `/assets/${A.server}`,
    shape: { params: { id: A.server }, body: { status: 'IN_STORAGE' } },
  },
  {
    controller: 'assets',
    method: 'update',
    http: 'patch',
    url: `/assets/${A.missing}`,
    shape: { params: { id: A.missing }, body: { status: 'IN_STORAGE' } },
  },
  {
    controller: 'assets',
    method: 'remove',
    http: 'delete',
    url: `/assets/${A.server}`,
    shape: { params: { id: A.server } },
  },
  {
    controller: 'assets',
    method: 'restore',
    http: 'post',
    url: `/assets/${A.archived}/restore`,
    shape: { params: { id: A.archived } },
  },
  {
    controller: 'assignments',
    method: 'create',
    http: 'post',
    url: '/asset-assignments',
    shape: { body: { assetId: A.server, userId: ID.ana } },
  },
  {
    controller: 'assignments',
    method: 'release',
    http: 'patch',
    url: `/asset-assignments/${ASSIGN.laptopAna}/release`,
    shape: { params: { id: ASSIGN.laptopAna }, body: {} },
  },
  {
    controller: 'users',
    method: 'findAll',
    http: 'get',
    url: '/users?q=ana',
    shape: { query: { q: 'ana' } },
  },
  {
    controller: 'users',
    method: 'me',
    http: 'get',
    url: '/users/me',
    shape: {},
  },
  {
    controller: 'models',
    method: 'findAll',
    http: 'get',
    url: '/asset-models?q=Latitude',
    shape: { query: { q: 'Latitude' } },
  },
  {
    controller: 'models',
    method: 'findOne',
    http: 'get',
    url: `/asset-models/${M.latitude}`,
    shape: { params: { id: M.latitude } },
  },
  {
    controller: 'locations',
    method: 'findAll',
    http: 'get',
    url: '/locations?q=HQ',
    shape: { query: { q: 'HQ' } },
  },
  {
    controller: 'locations',
    method: 'findOne',
    http: 'get',
    url: `/locations/${L.missing}`,
    shape: { params: { id: L.missing } },
  },
];

describe('assets toolset (W2-5) — asset_* tools', () => {
  const originalMode = process.env.AUTH_MODE;
  let h: Harness;

  beforeAll(async () => {
    process.env.AUTH_MODE = 'local';
    h = await bootHarness();
  });

  afterAll(async () => {
    await h.app.close();
    process.env.AUTH_MODE = originalMode;
  });

  beforeEach(() => resetAll(h));

  const data = (result: AiToolResult) => (result as { data: Row }).data;

  async function propose(
    name: string,
    input: unknown,
    who = 'MEMBER',
  ): Promise<AiPendingAction> {
    const proposal = await h.tools.propose(name, input, ctx(actor(who)));
    if (!proposal.ok) {
      throw new Error(`proposal refused: ${JSON.stringify(proposal.result)}`);
    }
    expect(
      AiActionPreviewSchema.safeParse(proposal.action.preview).success,
    ).toBe(true);
    expect(proposal.action.status).toBe('AWAITING_APPROVAL');
    return proposal.action;
  }

  const approve = (action: AiPendingAction, who = 'MEMBER') =>
    h.tools.approve(action.id, ctx(actor(who)));

  /** The history rows the last approved action wrote, all stamped with its invocation id. */
  function expectStamped(invocationId: string, eventType: string) {
    const rows = historyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventType, aiInvocationId: invocationId });
  }

  // ─── Parity ────────────────────────────────────────────────────────────────────────────────────────

  describe('route parity: every bound handler answers the tool exactly as it answers HTTP', () => {
    for (const a of ACTORS) {
      it.each(
        ROUTES.map((c) => [`${c.http.toUpperCase()} ${c.url}`, c] as const),
      )(`${a.label}: %s`, async (_label, c) => {
        expect(await viaDispatch(h, a, c)).toBe(await viaNetwork(h, a, c));
      });
    }

    it('covers ok, 400, 403 and 404 (the matrix is not vacuous)', async () => {
      const seen = new Set<number | 'ok'>();
      for (const a of ACTORS) {
        for (const c of ROUTES) seen.add(await viaDispatch(h, a, c));
      }
      expect([...seen]).toEqual(expect.arrayContaining([400, 403, 404, 'ok']));
    });
  });

  // ─── Reads ─────────────────────────────────────────────────────────────────────────────────────────

  describe('asset_search', () => {
    it('maps its filters onto the route and projects a concise page with owners', async () => {
      const result = await h.tools.invoke(
        'asset_search',
        { query: 'LT', status: 'OPERATIONAL', limit: 5 },
        ctx(actor('MEMBER')),
      );
      expect(AiToolResultSchema.safeParse(result).success).toBe(true);
      expect(result).toMatchObject({
        ok: true,
        kind: 'read',
        mutated: false,
        entityRefs: [],
      });
      const [filters, page] = assetsService.findPage.mock.calls.at(
        -1,
      ) as unknown as [Row, Row];
      expect(filters).toMatchObject({ q: 'LT', status: 'OPERATIONAL' });
      expect(page).toMatchObject({ limit: 5, offset: 0 });
      expect(data(result)).toEqual({
        total: 1,
        offset: 0,
        items: [
          {
            id: A.laptop,
            // A list row does not say who wrote the name and serial: wrapped (as infra lean rows are).
            name: '<untrusted_content>Laptop Ana</untrusted_content>',
            assetTag: 'LT-0001',
            serial: '<untrusted_content>SN-LAPTOP-1</untrusted_content>',
            status: 'OPERATIONAL',
            company: null,
            purchaseDate: null,
            warrantyEnd: null,
            model: {
              id: M.latitude,
              name: 'Latitude 7440',
              manufacturer: 'Dell',
              category: { id: ANY_STRING, name: 'Laptops' },
            },
            location: { id: L.hq, name: 'HQ', type: 'OFFICE' },
            owners: [
              {
                assignmentId: ASSIGN.laptopAna,
                userId: ID.ana,
                name: 'Ana Ops',
                email: 'ana@example.com',
              },
            ],
          },
        ],
      });
      // Never the notes or specs in a list row.
      expect(JSON.stringify(data(result))).not.toContain(INJECTION);
    });

    it('marks a truncated page with where to continue', async () => {
      const result = await h.tools.invoke(
        'asset_search',
        { limit: 2 },
        ctx(actor('MEMBER')),
      );
      expect(result).toMatchObject({
        ok: true,
        truncated: { shown: 2, total: 5, nextOffset: 2 },
      });
    });

    it('mine: the caller’s own assets through GET /assets/mine; no other filter allowed', async () => {
      const mine = await h.tools.invoke(
        'asset_search',
        { mine: true },
        ctx(actor('MEMBER')),
      );
      expect(mine.ok).toBe(true);
      expect(assetsService.findPage.mock.calls.at(-1)?.[2]).toBe(ID.member);

      const spy = jest.spyOn(h.dispatcher, 'dispatch');
      const bad = await h.tools.invoke(
        'asset_search',
        { mine: true, query: 'x' },
        ctx(actor('MEMBER')),
      );
      expect(bad).toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT' },
      });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('archived: administrators only, exactly like the route', async () => {
      const admin = await h.tools.invoke(
        'asset_search',
        { archived: true },
        ctx(actor('ADMIN')),
      );
      expect(data(admin).items).toEqual([
        expect.objectContaining({
          id: A.archived,
          archivedAt: '2026-08-01T00:00:00.000Z',
        }),
      ]);
      const member = await h.tools.invoke(
        'asset_search',
        { archived: true },
        ctx(actor('MEMBER')),
      );
      expect(member).toMatchObject({
        ok: false,
        error: { code: 'FORBIDDEN', status: 403 },
      });
    });
  });

  describe('asset_get', () => {
    it('concise, by asset tag: details, model, location, owners; notes wrapped as untrusted', async () => {
      const result = await h.tools.invoke(
        'asset_get',
        { asset: 'lt-0001' },
        ctx(actor('VIEWER')),
      );
      expect(result).toMatchObject({ ok: true, kind: 'read' });
      const d = data(result);
      expect(d.asset).toMatchObject({
        id: A.laptop,
        assetTag: 'LT-0001',
        purchaseCost: 150000,
        currentBookValue: 150000,
        updatedAt: T0.toISOString(),
        notes: WRAPPED,
      });
      expect(d.owners).toEqual([
        expect.objectContaining({ userId: ID.ana, name: 'Ana Ops' }),
      ]);
      expect(d).not.toHaveProperty('history');
      expect(d.asset).not.toHaveProperty('specs');
    });

    it('full: specs, ownership history, change history and articles — other-authored text wrapped', async () => {
      const result = await h.tools.invoke(
        'asset_get',
        { asset: A.laptop, detail: 'full' },
        ctx(actor('MEMBER')),
      );
      const d = data(result);
      const specs = (d.asset as Row).specs as string;
      expect(specs.startsWith('<untrusted_content>')).toBe(true);
      expect(specs).toContain('16 GB');
      expect(d.ownershipHistory).toMatchObject({
        total: 2,
        items: [
          expect.objectContaining({
            assignmentId: ASSIGN.laptopAna,
            notes: WRAPPED,
          }),
          expect.objectContaining({
            userId: ID.juan1,
            releasedAt: '2026-08-15T00:00:00.000Z',
          }),
        ],
      });
      expect((d.history as Row[])[0]).toMatchObject({ eventType: 'UPDATED' });
      expect(String((d.history as Row[])[0].payload)).toMatch(
        /^<untrusted_content>/,
      );
      expect(d.articles).toEqual({
        total: 1,
        items: [
          {
            id: ANY_STRING,
            slug: 'laptop-runbook',
            title: 'Laptop runbook',
          },
        ],
      });
      // Every occurrence of other-authored text sits inside an untrusted block.
      const outside = JSON.stringify(d).replace(
        /<untrusted_content>.*?<\/untrusted_content>/g,
        '',
      );
      expect(outside).not.toContain(INJECTION);
    });

    it('full, for a caller without article:read: the articles facet is reported unavailable', async () => {
      const result = await h.tools.invoke(
        'asset_get',
        { asset: 'LT-0001', detail: 'full' },
        ctx(actor('SA reader')),
      );
      expect(result.ok).toBe(true);
      expect(data(result).articles).toEqual({
        unavailable: 'forbidden for this caller',
      });
    });

    it('an ambiguous tag is AMBIGUOUS_REFERENCE naming the candidates; an unknown one NOT_FOUND', async () => {
      const ambiguous = await h.tools.invoke(
        'asset_get',
        { asset: 'DUP-1' },
        ctx(actor('MEMBER')),
      );
      expect(ambiguous).toMatchObject({
        ok: false,
        error: { code: 'AMBIGUOUS_REFERENCE', status: 409 },
      });
      const hint = (ambiguous as { error: { hint: string } }).error.hint;
      expect(hint).toContain(A.dupUpper);
      expect(hint).toContain(A.dupLower);

      const missing = await h.tools.invoke(
        'asset_get',
        { asset: 'NOPE-9' },
        ctx(actor('MEMBER')),
      );
      expect(missing).toMatchObject({
        ok: false,
        error: { code: 'NOT_FOUND' },
      });
      const missingId = await h.tools.invoke(
        'asset_get',
        { asset: A.missing },
        ctx(actor('MEMBER')),
      );
      expect(missingId).toMatchObject({
        ok: false,
        error: { code: 'NOT_FOUND', status: 404 },
      });
    });

    it('a caller without asset:read gets the route 403, even for a tag lookup', async () => {
      const result = await h.tools.invoke(
        'asset_get',
        { asset: 'LT-0001' },
        ctx(actor('SA with no grants')),
      );
      expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    });
  });

  // ─── Writes (chat: propose → approve) ──────────────────────────────────────────────────────────────

  describe('asset_create', () => {
    it('previews every field (model and location named), executes once on approval, history stamped', async () => {
      const action = await propose('asset_create', {
        name: 'Laptop Bob',
        status: 'IN_STORAGE',
        assetTag: 'LT-0100',
        purchaseCost: 99900,
        model: 'Latitude 7440',
        location: L.storage,
        specs: { ram: '32 GB' },
      });
      expect(action.preview).toMatchObject({
        toolName: 'asset_create',
        class: 'write',
        warnings: [],
        changes: expect.arrayContaining([
          { field: 'name', after: 'Laptop Bob', valueKind: 'text' },
          { field: 'purchaseCost', after: 99900, valueKind: 'number' },
          {
            field: 'model',
            after: {
              type: 'assetModel',
              id: M.latitude,
              label: 'Latitude 7440 (Dell)',
            },
            valueKind: 'entity',
          },
          {
            field: 'location',
            after: { type: 'location', id: L.storage, label: 'Storage Room' },
            valueKind: 'entity',
          },
        ]) as unknown,
      });
      expect(action.preview).not.toHaveProperty('target');
      expect(state.mutations).toBe(0);

      const approved = await approve(action);
      expect(approved).toMatchObject({
        status: 'SUCCEEDED',
        result: { ok: true, mutated: true },
      });
      expect(state.mutations).toBe(1);
      expect(assetsService.create.mock.calls[0][0]).toEqual({
        name: 'Laptop Bob',
        status: 'IN_STORAGE',
        assetTag: 'LT-0100',
        purchaseCost: 99900,
        specs: { ram: '32 GB' },
        modelId: M.latitude,
        locationId: L.storage,
      });
      expect(events(action.id)).toEqual(['PROPOSED', 'APPROVED', 'EXECUTED']);
      expectStamped(action.id, 'CREATED');
      expect(approved.result?.entityRefs).toEqual([
        expect.objectContaining({
          type: 'asset',
          op: 'created',
          label: 'Laptop Bob (LT-0100)',
        }),
      ]);
    });

    it('an ambiguous or unknown model fails the proposal; nothing is stored', async () => {
      state.models.set('c0000000000000000model3x', {
        ...state.models.get(M.latitude)!,
        id: 'c0000000000000000model3x',
        manufacturer: 'Other',
      });
      const ambiguous = await h.tools.propose(
        'asset_create',
        { name: 'X', status: 'IN_STORAGE', model: 'latitude 7440' },
        ctx(actor('MEMBER')),
      );
      expect(ambiguous).toMatchObject({
        ok: false,
        result: { error: { code: 'AMBIGUOUS_REFERENCE' } },
      });
      const unknown = await h.tools.propose(
        'asset_create',
        { name: 'X', status: 'IN_STORAGE', location: 'Mars' },
        ctx(actor('MEMBER')),
      );
      expect(unknown).toMatchObject({
        ok: false,
        result: { error: { code: 'NOT_FOUND' } },
      });
      expect(ai.invocations.size).toBe(0);
    });

    it('a VIEWER is refused by the authorization dry-check (DENIED), no card', async () => {
      const proposal = await h.tools.propose(
        'asset_create',
        { name: 'X', status: 'IN_STORAGE' },
        ctx(actor('VIEWER')),
      );
      expect(proposal).toMatchObject({
        ok: false,
        result: { error: { code: 'FORBIDDEN' } },
      });
      expect(ai.ledger.map((e) => e.event)).toEqual(['DENIED']);
      expect(state.mutations).toBe(0);
    });
  });

  describe('asset_update', () => {
    it('previews before → after with the version as precondition, and executes once', async () => {
      const action = await propose('asset_update', {
        asset: 'SN-LAPTOP-1',
        status: 'IN_MAINTENANCE',
        name: 'Laptop Ana', // unchanged: not on the card
        model: 'ThinkPad X1',
        specs: { ram: '32 GB', gpu: 'none' },
      });
      const target = {
        type: 'asset',
        id: A.laptop,
        op: 'updated',
        label: 'LT-0001',
      };
      expect(action.preview).toMatchObject({
        target,
        precondition: { entity: target, updatedAt: T0.toISOString() },
        changes: [
          {
            field: 'status',
            before: 'OPERATIONAL',
            after: 'IN_MAINTENANCE',
            valueKind: 'text',
          },
          {
            field: 'model',
            before: {
              type: 'assetModel',
              id: M.latitude,
              label: 'Latitude 7440 (Dell)',
            },
            after: {
              type: 'assetModel',
              id: M.thinkpad,
              label: 'ThinkPad X1 (Lenovo)',
            },
            valueKind: 'entity',
          },
          {
            field: 'specs.ram',
            before: '16 GB',
            after: '32 GB',
            valueKind: 'text',
          },
          {
            field: 'specs.gpu',
            before: null,
            after: 'none',
            valueKind: 'text',
          },
        ],
      });

      const approved = await approve(action);
      expect(approved.status).toBe('SUCCEEDED');
      expect(assetsService.update).toHaveBeenCalledTimes(1);
      const [id, body] = assetsService.update.mock.calls[0] as [string, Row];
      expect(id).toBe(A.laptop);
      // specs are MERGED: the agent-reported host facts survive an AI edit.
      expect(body).toEqual({
        name: 'Laptop Ana',
        status: 'IN_MAINTENANCE',
        modelId: M.thinkpad,
        specs: {
          ram: '32 GB',
          gpu: 'none',
          host: { hostname: 'ana-lt', os: INJECTION },
        },
      });
      expectStamped(action.id, 'UPDATED');
      expect(events(action.id)).toEqual(['PROPOSED', 'APPROVED', 'EXECUTED']);
    });

    it('a target changed since the preview is STALE and nothing executes', async () => {
      const action = await propose('asset_update', {
        asset: 'LT-0001',
        status: 'LOST',
      });
      touch(state.assets.get(A.laptop)!);
      const approved = await approve(action);
      expect(approved).toMatchObject({
        status: 'FAILED',
        result: { ok: false, error: { code: 'STALE', status: 409 } },
      });
      expect(assetsService.update).not.toHaveBeenCalled();
      expect(events(action.id)).toEqual(['PROPOSED', 'APPROVED', 'FAILED']);
    });

    it('nothing to change, or no field at all, is refused before any card', async () => {
      const same = await h.tools.propose(
        'asset_update',
        { asset: 'LT-0001', status: 'OPERATIONAL' },
        ctx(actor('MEMBER')),
      );
      expect(same).toMatchObject({
        ok: false,
        result: { error: { code: 'INVALID_INPUT' } },
      });
      const empty = await h.tools.propose(
        'asset_update',
        { asset: 'LT-0001' },
        ctx(actor('MEMBER')),
      );
      expect(empty).toMatchObject({
        ok: false,
        result: { error: { code: 'INVALID_INPUT' } },
      });
      expect(ai.invocations.size).toBe(0);
    });
  });

  describe('asset_archive', () => {
    it('ADMIN: a soft delete with its warning; the card says who still holds the asset', async () => {
      const action = await propose(
        'asset_archive',
        { asset: 'LT-0001' },
        'ADMIN',
      );
      expect(action.preview).toMatchObject({
        target: { type: 'asset', id: A.laptop, op: 'archived' },
        warnings: ['SOFT_DELETE'],
        changes: [
          {
            field: 'archived',
            before: false,
            after: true,
            valueKind: 'boolean',
          },
          {
            field: 'owners',
            before: ['Ana Ops <ana@example.com>'],
            after: ['Ana Ops <ana@example.com>'],
          },
        ],
        precondition: { updatedAt: T0.toISOString() },
      });
      const approved = await approve(action, 'ADMIN');
      expect(approved.status).toBe('SUCCEEDED');
      expect(state.assets.get(A.laptop)!.deletedAt).not.toBeNull();
      expectStamped(action.id, 'DELETED');
      expect(approved.result?.entityRefs).toEqual([
        expect.objectContaining({ id: A.laptop, op: 'archived' }),
      ]);
    });

    it('a MEMBER (no asset:delete) is DENIED at propose, as the route would 403', async () => {
      const proposal = await h.tools.propose(
        'asset_archive',
        { asset: 'LT-0001' },
        ctx(actor('MEMBER')),
      );
      expect(proposal).toMatchObject({
        ok: false,
        result: { error: { code: 'FORBIDDEN' } },
      });
      expect(assetsService.remove).not.toHaveBeenCalled();
    });

    it('STALE when the asset changed in between', async () => {
      const action = await propose(
        'asset_archive',
        { asset: A.server },
        'ADMIN',
      );
      touch(state.assets.get(A.server)!);
      expect((await approve(action, 'ADMIN')).result).toMatchObject({
        error: { code: 'STALE' },
      });
      expect(assetsService.remove).not.toHaveBeenCalled();
    });
  });

  describe('asset_restore', () => {
    it('finds an archived asset by tag, previews it and restores it', async () => {
      const action = await propose(
        'asset_restore',
        { asset: 'OLD-0001' },
        'ADMIN',
      );
      expect(action.preview).toMatchObject({
        target: {
          type: 'asset',
          id: A.archived,
          op: 'restored',
          label: 'OLD-0001',
        },
        changes: [{ field: 'archived', before: true, after: false }],
        precondition: { updatedAt: '2026-08-01T00:00:00.000Z' },
      });
      const approved = await approve(action, 'ADMIN');
      expect(approved.status).toBe('SUCCEEDED');
      expect(state.assets.get(A.archived)!.deletedAt).toBeNull();
      expectStamped(action.id, 'RESTORED');
    });

    it('by raw id too (the archived list has no id filter: the newest-archived pages are scanned)', async () => {
      const action = await propose(
        'asset_restore',
        { asset: A.archived },
        'ADMIN',
      );
      expect(action.preview?.target?.id).toBe(A.archived);
    });

    it('a live asset is not restorable: NOT_FOUND among archived assets', async () => {
      const proposal = await h.tools.propose(
        'asset_restore',
        { asset: 'LT-0001' },
        ctx(actor('ADMIN')),
      );
      expect(proposal).toMatchObject({
        ok: false,
        result: { error: { code: 'NOT_FOUND' } },
      });
    });
  });

  describe('asset_check_out', () => {
    it('names the asset and the person on the card, opens the assignment once, history stamped', async () => {
      const action = await propose('asset_check_out', {
        asset: 'SRV-0001',
        user: 'ANA@example.com',
        notes: 'On-call kit',
      });
      const target = {
        type: 'asset',
        id: A.server,
        op: 'updated',
        label: 'Server (SRV-0001)',
      };
      expect(action.preview).toMatchObject({
        target,
        precondition: { entity: target, updatedAt: T0.toISOString() },
        changes: [
          {
            field: 'checkedOutTo',
            before: null,
            after: {
              type: 'user',
              id: ID.ana,
              label: 'Ana Ops <ana@example.com>',
            },
            valueKind: 'entity',
          },
          { field: 'owners', before: [], after: ['Ana Ops <ana@example.com>'] },
          { field: 'notes', after: 'On-call kit' },
        ],
      });

      const approved = await approve(action);
      expect(approved.status).toBe('SUCCEEDED');
      expect(assignmentsService.create).toHaveBeenCalledTimes(1);
      expect(assignmentsService.create.mock.calls[0][0]).toEqual({
        assetId: A.server,
        userId: ID.ana,
        notes: 'On-call kit',
      });
      expectStamped(action.id, 'ASSIGNED');
      expect(historyRows()[0]).toMatchObject({ performedById: ID.member });
      const refs = approved.result!.entityRefs;
      expect(refs).toEqual([
        expect.objectContaining({
          type: 'assetAssignment',
          op: 'created',
          parent: { type: 'asset', id: A.server },
        }),
        expect.objectContaining({
          type: 'asset',
          id: A.server,
          op: 'updated',
          label: 'SRV-0001',
        }),
        expect.objectContaining({ type: 'user', id: ID.ana, op: 'updated' }),
      ]);
    });

    it('"me" checks it out to the caller', async () => {
      const action = await propose('asset_check_out', {
        asset: A.server,
        user: 'me',
      });
      expect(action.preview?.changes[0]).toMatchObject({
        after: { type: 'user', id: ID.member },
      });
      await approve(action);
      expect(assignmentsService.create.mock.calls[0][0]).toMatchObject({
        userId: ID.member,
      });
    });

    it('an ambiguous person is AMBIGUOUS_REFERENCE with both candidates; an existing owner is CONFLICT', async () => {
      const ambiguous = await h.tools.propose(
        'asset_check_out',
        { asset: A.server, user: 'Juan Perez' },
        ctx(actor('MEMBER')),
      );
      expect(ambiguous).toMatchObject({
        ok: false,
        result: { error: { code: 'AMBIGUOUS_REFERENCE' } },
      });
      const hint = (ambiguous as { result: { error: { hint: string } } }).result
        .error.hint;
      expect(hint).toContain(ID.juan1);
      expect(hint).toContain(ID.juan2);

      const owned = await h.tools.propose(
        'asset_check_out',
        { asset: 'LT-0001', user: ID.ana },
        ctx(actor('MEMBER')),
      );
      expect(owned).toMatchObject({
        ok: false,
        result: { error: { code: 'CONFLICT', status: 409 } },
      });
      expect(ai.invocations.size).toBe(0);
    });

    it('STALE when the asset changed before the approval', async () => {
      const action = await propose('asset_check_out', {
        asset: A.server,
        user: ID.ana,
      });
      touch(state.assets.get(A.server)!);
      expect((await approve(action)).result).toMatchObject({
        error: { code: 'STALE' },
      });
      expect(assignmentsService.create).not.toHaveBeenCalled();
    });
  });

  describe('asset_check_in', () => {
    it('several owners and no person: AMBIGUOUS_REFERENCE naming them', async () => {
      const proposal = await h.tools.propose(
        'asset_check_in',
        { asset: 'TAB-0001' },
        ctx(actor('MEMBER')),
      );
      expect(proposal).toMatchObject({
        ok: false,
        result: { error: { code: 'AMBIGUOUS_REFERENCE' } },
      });
      const hint = (proposal as { result: { error: { hint: string } } }).result
        .error.hint;
      expect(hint).toContain('Ana Ops');
      expect(hint).toContain('Juan Perez');
    });

    it('releases the named owner’s assignment: the card targets the assignment on its asset', async () => {
      const action = await propose('asset_check_in', {
        asset: 'TAB-0001',
        user: 'juan1@example.com',
        notes: 'Returned',
      });
      const target = {
        type: 'assetAssignment',
        id: ASSIGN.sharedJuan,
        op: 'updated',
        label: 'TAB-0001 → Juan Perez <juan1@example.com>',
        parent: { type: 'asset', id: A.shared },
      };
      expect(action.preview).toMatchObject({
        target,
        precondition: { entity: target, updatedAt: T0.toISOString() },
        changes: [
          {
            field: 'checkedInFrom',
            before: {
              type: 'user',
              id: ID.juan1,
              label: 'Juan Perez <juan1@example.com>',
            },
            after: null,
            valueKind: 'entity',
          },
          {
            field: 'owners',
            before: [
              'Ana Ops <ana@example.com>',
              'Juan Perez <juan1@example.com>',
            ],
            after: ['Ana Ops <ana@example.com>'],
          },
          { field: 'notes', before: null, after: 'Returned' },
        ],
      });
      const approved = await approve(action);
      expect(approved.status).toBe('SUCCEEDED');
      expect(assignmentsService.release).toHaveBeenCalledTimes(1);
      expect(assignmentsService.release.mock.calls[0].slice(0, 2)).toEqual([
        ASSIGN.sharedJuan,
        { notes: 'Returned' },
      ]);
      expectStamped(action.id, 'RELEASED');
      expect(approved.result!.entityRefs[0]).toMatchObject({
        type: 'assetAssignment',
        id: ASSIGN.sharedJuan,
        op: 'updated',
        parent: { type: 'asset', id: A.shared },
      });
    });

    it('a single owner needs no person; a person who holds nothing is NOT_FOUND', async () => {
      const action = await propose('asset_check_in', { asset: 'LT-0001' });
      expect(action.preview?.target?.id).toBe(ASSIGN.laptopAna);
      const nobody = await h.tools.propose(
        'asset_check_in',
        { asset: 'LT-0001', user: 'juan2@example.com' },
        ctx(actor('MEMBER')),
      );
      expect(nobody).toMatchObject({
        ok: false,
        result: { error: { code: 'NOT_FOUND' } },
      });
      const unowned = await h.tools.propose(
        'asset_check_in',
        { asset: 'SRV-0001' },
        ctx(actor('MEMBER')),
      );
      expect(unowned).toMatchObject({
        ok: false,
        result: { error: { code: 'CONFLICT' } },
      });
    });

    it('STALE when the assignment changed before the approval', async () => {
      const action = await propose('asset_check_in', { asset: 'LT-0001' });
      touch(state.assignments.get(ASSIGN.laptopAna)!);
      expect((await approve(action)).result).toMatchObject({
        error: { code: 'STALE' },
      });
      expect(assignmentsService.release).not.toHaveBeenCalled();
    });
  });

  // ─── MCP and headless ──────────────────────────────────────────────────────────────────────────────

  describe('MCP and headless: invoke within the class ceiling', () => {
    it('MCP (lazyit.write): executes once, ATTEMPTED → EXECUTED, history stamped with the row id', async () => {
      const result = await h.tools.invoke(
        'asset_update',
        { asset: 'LT-0001', status: 'IN_STORAGE' },
        mcp(actor('MEMBER')),
      );
      expect(AiToolResultSchema.safeParse(result).success).toBe(true);
      expect(result).toMatchObject({
        ok: true,
        kind: 'mutation',
        mutated: true,
      });
      const [row] = [...ai.invocations.values()];
      expect(row).toMatchObject({
        status: 'SUCCEEDED',
        channel: 'MCP',
        toolName: 'asset_update',
      });
      expect(events(row.id)).toEqual(['ATTEMPTED', 'EXECUTED']);
      expectStamped(row.id, 'UPDATED');
    });

    it('MCP under a read-only ceiling: DENIED, nothing dispatched', async () => {
      const result = await h.tools.invoke(
        'asset_check_out',
        { asset: A.server, user: ID.ana },
        mcp(actor('MEMBER'), ['read']),
      );
      expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
      expect(ai.ledger.map((e) => e.event)).toEqual(['ATTEMPTED', 'DENIED']);
      expect(state.mutations).toBe(0);
    });

    it('headless SA: raw ids pass straight to the write handler; check-out and check-in both execute', async () => {
      const sa = actor('SA writer');
      const out = await h.tools.invoke(
        'asset_check_out',
        { asset: A.server, user: ID.ana },
        ctx(sa),
      );
      expect(out).toMatchObject({ ok: true, mutated: true });
      // A raw user id is not looked up: no directory read was needed.
      const back = await h.tools.invoke(
        'asset_check_in',
        { asset: A.server },
        ctx(sa),
      );
      expect(back).toMatchObject({ ok: true, mutated: true });
      expect(
        historyRows().map((r) => [r.eventType, r.serviceAccountId]),
      ).toEqual([
        ['ASSIGNED', ANY_STRING],
        ['RELEASED', ANY_STRING],
      ]);
      expect(state.mutations).toBe(2);
    });

    it('headless SA without asset:write: the route 403, recorded as FAILED', async () => {
      const result = await h.tools.invoke(
        'asset_update',
        { asset: A.server, status: 'LOST' },
        ctx(actor('SA reader')),
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'FORBIDDEN', status: 403 },
      });
      expect(ai.ledger.map((e) => e.event)).toEqual(['ATTEMPTED', 'FAILED']);
      expect(state.mutations).toBe(0);
    });

    it('a chat write is never invoked directly (only approve executes it)', async () => {
      const result = await h.tools.invoke(
        'asset_create',
        { name: 'X', status: 'LOST' },
        ctx(actor('MEMBER')),
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'NOT_AVAILABLE' },
      });
      expect(state.mutations).toBe(0);
    });
  });

  describe('listing: the route decides who sees what', () => {
    const names = async (label: string) =>
      (await h.tools.list(ctx(actor(label))))
        .map((t) => t.name)
        .filter((n) => n.startsWith('asset_'));

    it('ADMIN all, MEMBER no archive/restore, VIEWER reads only', async () => {
      expect(await names('ADMIN')).toEqual([
        'asset_archive',
        'asset_check_in',
        'asset_check_out',
        'asset_create',
        'asset_get',
        'asset_model_create',
        'asset_restore',
        'asset_search',
        'asset_update',
      ]);
      expect(await names('MEMBER')).toEqual([
        'asset_check_in',
        'asset_check_out',
        'asset_create',
        'asset_get',
        'asset_model_create',
        'asset_search',
        'asset_update',
      ]);
      expect(await names('VIEWER')).toEqual(['asset_get', 'asset_search']);
    });

    it('a role the operator stripped of asset:read loses the reads and gets the route 403', async () => {
      matrix.current = {
        ...matrix.current,
        MEMBER: matrix.current.MEMBER.filter((p) => p !== 'asset:read'),
      };
      h.resolver.invalidate();
      expect(await names('MEMBER')).not.toContain('asset_search');
      const result = await h.tools.invoke(
        'asset_search',
        {},
        ctx(actor('MEMBER')),
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'FORBIDDEN', status: 403 },
      });
    });

    it('write tools carry the MCP destructive hint only where §7 marks them ·D', async () => {
      const listing = await h.tools.list(mcp(actor('ADMIN')));
      const hint = (name: string) =>
        listing.find((t) => t.name === name)?.annotations.destructiveHint;
      expect(hint('asset_update')).toBe(true);
      expect(hint('asset_archive')).toBe(true);
      expect(hint('asset_create')).toBe(false);
      expect(hint('asset_check_out')).toBe(false);
      expect(hint('asset_check_in')).toBe(false);
      expect(hint('asset_restore')).toBe(false);
    });
  });

  // ─── Review fixes (G2, #1346) ──────────────────────────────────────────────────────────────────────

  /** Clone a fixture asset under a new id, tag and serial. */
  function addAsset(key: string, over: Row): string {
    const id = cid(key);
    state.assets.set(id, {
      ...state.assets.get(A.server)!,
      id,
      serial: null,
      ...over,
    });
    return id;
  }

  let userSeq = 0;
  function addUser(key: string, first: string, last: string): string {
    userSeq += 1;
    const id = `bbbbbbbb-0000-4000-8000-${String(userSeq).padStart(12, '0')}`;
    state.users.set(id, {
      id,
      firstName: first,
      lastName: last,
      email: `${key}@example.com`,
      username: null,
      legajo: null,
      role: 'MEMBER',
      deletedAt: null,
    });
    return id;
  }

  describe('review fix F1: a partial lookup page never decides a reference', () => {
    it('LT-1 resolves exactly (never LT-10) while one page holds every match…', async () => {
      const lt1 = addAsset('lt1', { name: 'Dock', assetTag: 'LT-1' });
      addAsset('lt10', { name: 'Dock', assetTag: 'LT-10' });
      const result = await h.tools.invoke(
        'asset_get',
        { asset: 'lt-1' },
        ctx(actor('MEMBER')),
      );
      expect(data(result).asset).toMatchObject({ id: lt1, assetTag: 'LT-1' });
    });

    it('…and is AMBIGUOUS_REFERENCE (ask for the id) once more rows match than one page reads', async () => {
      const lt1 = addAsset('lt1', { name: 'Dock', assetTag: 'LT-1' });
      for (let i = 0; i < 200; i += 1) {
        addAsset(`lt1x${i}`, { name: 'Dock', assetTag: `LT-1${i}` });
      }
      // The exact match is on the first page — still refused: the page does not hold every candidate.
      expect(state.assets.size).toBeGreaterThan(201);
      const result = await h.tools.invoke(
        'asset_update',
        { asset: 'LT-1', status: 'LOST' },
        ctx(actor('SA writer')),
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'AMBIGUOUS_REFERENCE' },
      });
      expect((result as { error: { message: string } }).error.message).toMatch(
        /id/,
      );
      expect(assetsService.update).not.toHaveBeenCalled();
      // The id still works.
      const byId = await h.tools.invoke(
        'asset_update',
        { asset: lt1, status: 'LOST' },
        ctx(actor('SA writer')),
      );
      expect(byId.ok).toBe(true);
    });

    it('a person: an exact name past the page is refused, not missed (NOT_FOUND) or misread', async () => {
      for (let i = 0; i < 200; i += 1)
        addUser(`smithson${i}`, 'John', `Smithson${i}`);
      const older = addUser('smith', 'John', 'Smith'); // inserted last: off the first page
      const proposal = await h.tools.propose(
        'asset_check_out',
        { asset: A.server, user: 'John Smith' },
        ctx(actor('MEMBER')),
      );
      expect(proposal).toMatchObject({
        ok: false,
        result: { error: { code: 'AMBIGUOUS_REFERENCE' } },
      });
      expect(ai.invocations.size).toBe(0);
      const byEmail = await h.tools.propose(
        'asset_check_out',
        { asset: A.server, user: older },
        ctx(actor('MEMBER')),
      );
      expect(byEmail).toMatchObject({ ok: true });
    });

    it('several exact matches on a partial page are named as candidates', async () => {
      for (let i = 0; i < 201; i += 1)
        addUser(`perez${i}`, 'Juan', `Perezz${i}`);
      const proposal = await h.tools.propose(
        'asset_check_out',
        { asset: A.server, user: 'Juan Perez' },
        ctx(actor('MEMBER')),
      );
      const hint = (proposal as { result: { error: { hint?: string } } }).result
        .error.hint;
      expect(hint).toContain(ID.juan1);
      expect(hint).toContain(ID.juan2);
    });

    it('a model or location name past the page is refused too', async () => {
      for (let i = 0; i < 201; i += 1) {
        const id = cid(`hqannex${i}`);
        state.locations.set(id, {
          ...state.locations.get(L.storage)!,
          id,
          name: `HQ annex ${i}`,
        });
      }
      const result = await h.tools.invoke(
        'asset_create',
        { name: 'X', status: 'IN_STORAGE', location: 'HQ' },
        ctx(actor('SA writer')),
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'AMBIGUOUS_REFERENCE' },
      });
      expect(assetsService.create).not.toHaveBeenCalled();
    });

    it('archived: a tag past the page, or a raw id beyond the scanned pages, is refused', async () => {
      for (let i = 0; i < 1001; i += 1) {
        addAsset(`gone${i}`, {
          name: 'Gone',
          assetTag: `OLD-0001-${i}`,
          deletedAt: new Date('2026-09-05T00:00:00.000Z'),
          updatedAt: new Date('2026-09-05T00:00:00.000Z'),
        });
      }
      const byTag = await h.tools.propose(
        'asset_restore',
        { asset: 'OLD-0001' },
        ctx(actor('ADMIN')),
      );
      expect(byTag).toMatchObject({
        ok: false,
        result: { error: { code: 'AMBIGUOUS_REFERENCE' } },
      });
      // The fixture's archived asset is older than the 1,000 newest-archived rows the scan reads.
      const byId = await h.tools.propose(
        'asset_restore',
        { asset: A.archived },
        ctx(actor('ADMIN')),
      );
      expect(byId).toMatchObject({
        ok: false,
        result: { error: { code: 'AMBIGUOUS_REFERENCE' } },
      });
      expect(
        (byId as { result: { error: { message: string } } }).result.error
          .message,
      ).toMatch(/asset tag or serial/);
    });
  });

  describe('review fix F2: agent-owned spec keys are not tool input', () => {
    it('host and _-prefixed keys are refused on update and create, before any dispatch', async () => {
      const spy = jest.spyOn(h.dispatcher, 'dispatch');
      for (const [name, input] of [
        ['asset_update', { asset: A.laptop, specs: { host: 'forged' } }],
        ['asset_update', { asset: A.laptop, specs: { Host: null } }],
        [
          'asset_update',
          { asset: A.laptop, specs: { _infraAutoCreated: null } },
        ],
        [
          'asset_create',
          { name: 'X', status: 'LOST', specs: { _infraAutoCreated: true } },
        ],
      ] as const) {
        const proposal = await h.tools.propose(
          name,
          input,
          ctx(actor('MEMBER')),
        );
        expect(proposal).toMatchObject({
          ok: false,
          result: { error: { code: 'INVALID_INPUT' } },
        });
      }
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();

      // A `__proto__` key never becomes an own key of the parsed input (the schema drops it), so it
      // cannot reach the merged specs: the update is left with nothing to change.
      const proto = await h.tools.propose(
        'asset_update',
        {
          asset: A.laptop,
          specs: JSON.parse('{"__proto__": {"polluted": true}}') as Row,
        },
        ctx(actor('MEMBER')),
      );
      expect(proto).toMatchObject({
        ok: false,
        result: { error: { code: 'INVALID_INPUT' } },
      });
      expect(({} as Row).polluted).toBeUndefined();
    });
  });

  describe('review fix F3: a name or serial a reporting agent wrote is untrusted', () => {
    it('agent-linked (specs.host) and auto-created (_infraAutoCreated) assets: wrapped, and kept out of labels', async () => {
      const auto = addAsset('auto1', {
        name: INJECTION,
        serial: 'SN-REPORTED',
        assetTag: 'AUTO-1',
        specs: { _infraAutoCreated: true },
      });
      const got = await h.tools.invoke(
        'asset_get',
        { asset: auto },
        ctx(actor('MEMBER')),
      );
      expect(data(got).asset).toMatchObject({
        name: WRAPPED,
        serial: '<untrusted_content>SN-REPORTED</untrusted_content>',
      });
      const linked = await h.tools.invoke(
        'asset_get',
        { asset: A.laptop },
        ctx(actor('MEMBER')),
      );
      expect(data(linked).asset).toMatchObject({
        name: '<untrusted_content>Laptop Ana</untrusted_content>',
      });
      const archive = await h.tools.propose(
        'asset_archive',
        { asset: auto },
        ctx(actor('ADMIN')),
      );
      if (!archive.ok) throw new Error('refused');
      expect(archive.action.preview?.target?.label).toBe('AUTO-1');
      expect(JSON.stringify(archive.action.preview)).not.toContain(INJECTION);
    });

    it('an operator-curated asset (no agent specs) keeps its plain name', async () => {
      const got = await h.tools.invoke(
        'asset_get',
        { asset: A.server },
        ctx(actor('MEMBER')),
      );
      expect(data(got).asset).toMatchObject({ name: 'Server', serial: null });
    });
  });

  describe('review fix F6: own spec keys only; Decimal and bigint compared by value', () => {
    it('a key named like an Object.prototype member has no inherited "before"', async () => {
      const action = await propose('asset_update', {
        asset: A.server,
        specs: { constructor: 'x' },
      });
      expect(action.preview?.changes).toEqual([
        {
          field: 'specs.constructor',
          before: null,
          after: 'x',
          valueKind: 'text',
        },
      ]);
      await approve(action);
      const [, body] = assetsService.update.mock.calls[0] as unknown as [
        string,
        Row,
      ];
      expect(Object.getPrototypeOf(body.specs)).toBe(Object.prototype);
      expect(body.specs).toEqual({ constructor: 'x' });
    });

    it('a bigint or Decimal before-value is normalized: no false change, a JSON-safe preview', async () => {
      state.assets.get(A.server)!.purchaseCost = BigInt(1500);
      const same = await h.tools.propose(
        'asset_update',
        { asset: A.server, purchaseCost: 1500 },
        ctx(actor('MEMBER')),
      );
      expect(same).toMatchObject({
        ok: false,
        result: { error: { code: 'INVALID_INPUT' } },
      });
      const changed = await propose('asset_update', {
        asset: A.server,
        purchaseCost: 2000,
      });
      expect(changed.preview?.changes).toEqual([
        {
          field: 'purchaseCost',
          before: 1500,
          after: 2000,
          valueKind: 'number',
        },
      ]);

      state.assets.get(A.server)!.salvageValue = {
        toNumber: () => 100,
        toFixed: () => '100',
        toString: () => '100',
      };
      const decimal = await h.tools.propose(
        'asset_update',
        { asset: A.server, salvageValue: 100 },
        ctx(actor('MEMBER')),
      );
      expect(decimal).toMatchObject({
        ok: false,
        result: { error: { code: 'INVALID_INPUT' } },
      });
    });
  });
});
