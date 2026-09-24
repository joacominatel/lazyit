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

import {
  ACTORS,
  C,
  INJECTION,
  L,
  M,
  actor,
  ai,
  articleFolders,
  bootHarness,
  ctx,
  events,
  locationsService,
  matrix,
  mcp,
  modelsService,
  resetAll,
  state,
  viaDispatch,
  viaNetwork,
  type Harness,
  type RouteCase,
} from './asset-tools.harness-spec';

type Row = Record<string, unknown>;
const WRAPPED = `<untrusted_content>${INJECTION}</untrusted_content>`;

/** Every route the reference tools bind (ok / 400 / 403 / 404 across the principals). */
const ROUTES: RouteCase[] = [
  {
    controller: 'models',
    method: 'findAll',
    http: 'get',
    url: '/asset-models?q=Lat&limit=5',
    shape: { query: { q: 'Lat', limit: '5' } },
  },
  {
    controller: 'models',
    method: 'findAll',
    http: 'get',
    url: '/asset-models?sort=specs',
    shape: { query: { sort: 'specs' } },
  },
  {
    controller: 'models',
    method: 'findOne',
    http: 'get',
    url: `/asset-models/${M.latitude}`,
    shape: { params: { id: M.latitude } },
  },
  {
    controller: 'models',
    method: 'create',
    http: 'post',
    url: '/asset-models',
    shape: { body: { name: 'EliteBook', manufacturer: 'HP' } },
  },
  {
    controller: 'models',
    method: 'create',
    http: 'post',
    url: '/asset-models',
    shape: { body: { name: 'EliteBook' } },
  },
  {
    controller: 'locations',
    method: 'findAll',
    http: 'get',
    url: '/locations?type=MOON',
    shape: { query: { type: 'MOON' } },
  },
  {
    controller: 'locations',
    method: 'findOne',
    http: 'get',
    url: `/locations/${L.storage}`,
    shape: { params: { id: L.storage } },
  },
  {
    controller: 'locations',
    method: 'findOne',
    http: 'get',
    url: `/locations/${L.missing}`,
    shape: { params: { id: L.missing } },
  },
  {
    controller: 'locations',
    method: 'create',
    http: 'post',
    url: '/locations',
    shape: { body: { name: 'Lab', type: 'OTHER' } },
  },
  {
    controller: 'assetCategories',
    method: 'findAll',
    http: 'get',
    url: '/asset-categories',
    shape: {},
  },
  {
    controller: 'assetCategories',
    method: 'findOne',
    http: 'get',
    url: `/asset-categories/${C.laptops}`,
    shape: { params: { id: C.laptops } },
  },
  {
    controller: 'applicationCategories',
    method: 'findAll',
    http: 'get',
    url: '/application-categories',
    shape: {},
  },
  {
    controller: 'consumableCategories',
    method: 'findOne',
    http: 'get',
    url: `/consumable-categories/${C.saas}`,
    shape: { params: { id: C.saas } },
  },
  {
    controller: 'articleFolders',
    method: 'findAll',
    http: 'get',
    url: '/article-categories',
    shape: {},
  },
];

describe('reference toolset (W2-5) — reference_lookup, asset_model_create, location_create', () => {
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
  const lookup = (input: Row, who = 'VIEWER') =>
    h.tools.invoke('reference_lookup', input, ctx(actor(who)));

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

  describe('reference_lookup', () => {
    it('asset models: a paged, name-sorted search; descriptions only in full, wrapped', async () => {
      const result = await lookup({
        kind: 'assetModel',
        query: 'Lat',
        limit: 5,
      });
      expect(AiToolResultSchema.safeParse(result).success).toBe(true);
      expect(result).toMatchObject({ ok: true, kind: 'read', entityRefs: [] });
      const [filters, page] = modelsService.findPage.mock.calls.at(
        -1,
      ) as unknown as [Row, Row];
      expect(filters).toMatchObject({ q: 'Lat' });
      expect(page).toMatchObject({
        limit: 5,
        offset: 0,
        sort: 'name',
        dir: 'asc',
      });
      expect(data(result)).toEqual({
        kind: 'assetModel',
        total: 1,
        offset: 0,
        items: [
          {
            id: M.latitude,
            name: 'Latitude 7440',
            manufacturer: 'Dell',
            sku: null,
            categoryId: C.laptops,
          },
        ],
      });

      const full = await lookup({
        kind: 'assetModel',
        id: M.latitude,
        detail: 'full',
      });
      expect(data(full).item).toMatchObject({
        id: M.latitude,
        description: WRAPPED,
      });
      expect(String((data(full).item as Row).specs)).toMatch(
        /^<untrusted_content>.*16 GB/,
      );
    });

    it('a location by id carries its breadcrumb; notes are wrapped in full', async () => {
      const result = await lookup({
        kind: 'location',
        id: L.storage,
        detail: 'full',
      });
      expect(data(result).item).toMatchObject({
        id: L.storage,
        name: 'Storage Room',
        type: 'STORAGE',
        parentId: L.hq,
        path: [
          { id: L.hq, name: 'HQ', type: 'OFFICE' },
          { id: L.storage, name: 'Storage Room', type: 'STORAGE' },
        ],
      });
      const hq = await lookup({ kind: 'location', id: L.hq, detail: 'full' });
      expect((data(hq).item as Row).notes).toBe(WRAPPED);
      expect(locationsService.findOneWithAncestors).toHaveBeenCalledWith(L.hq);
    });

    it('the unpaged taxonomies are filtered and paged here, with a truncation marker', async () => {
      const categories = await lookup({ kind: 'assetCategory', limit: 1 });
      expect(categories).toMatchObject({
        ok: true,
        data: {
          kind: 'assetCategory',
          total: 2,
          items: [{ id: C.laptops, name: 'Laptops' }],
        },
        truncated: { shown: 1, total: 2, nextOffset: 1 },
      });
      const filtered = await lookup({ kind: 'assetCategory', query: 'serv' });
      expect(data(filtered).items).toEqual([
        { id: C.servers, name: 'Servers' },
      ]);
      expect(data(await lookup({ kind: 'applicationCategory' })).items).toEqual(
        [{ id: C.saas, name: 'SaaS' }],
      );
      expect(
        data(await lookup({ kind: 'consumableCategory', detail: 'full' }))
          .items,
      ).toEqual([{ id: C.toner, name: 'Toner', description: WRAPPED }]);
    });

    it('KB folders: read as the principal, and the access rules never leave the tool', async () => {
      const result = await lookup({ kind: 'articleFolder' }, 'ADMIN');
      expect(data(result).items).toEqual([
        {
          id: C.runbooks,
          name: 'Runbooks',
          parentId: null,
          order: 1,
          articleCount: 3,
        },
        {
          id: C.restricted,
          name: 'Restricted',
          parentId: null,
          order: 2,
          articleCount: null,
        },
      ]);
      expect(JSON.stringify(data(result))).not.toContain('accessRules');
      // The route receives the principal, so folder visibility is the route's own.
      expect(articleFolders.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'human' }),
      );

      // One folder by id: the same principal-aware route (folder ACL), the same projection.
      const one = await lookup(
        { kind: 'articleFolder', id: C.restricted, detail: 'full' },
        'ADMIN',
      );
      expect(data(one).item).toEqual({
        id: C.restricted,
        name: 'Restricted',
        parentId: null,
        order: 2,
        articleCount: null,
        description: WRAPPED,
      });
      expect(articleFolders.findOne).toHaveBeenCalledWith(
        C.restricted,
        expect.objectContaining({ kind: 'human' }),
      );
    });

    it('a missing id is the route’s 404; invalid input is refused before any dispatch', async () => {
      expect(await lookup({ kind: 'location', id: L.missing })).toMatchObject({
        ok: false,
        error: { code: 'NOT_FOUND', status: 404 },
      });
      const spy = jest.spyOn(h.dispatcher, 'dispatch');
      for (const bad of [
        {},
        { kind: 'vendor' },
        { kind: 'location', id: 'nope' },
        { kind: 'location', limit: 51 },
      ]) {
        expect(await lookup(bad)).toMatchObject({
          ok: false,
          error: { code: 'INVALID_INPUT' },
        });
      }
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('each kind is authorized by its own route: a role stripped of location:read gets that 403', async () => {
      matrix.current = {
        ...matrix.current,
        MEMBER: matrix.current.MEMBER.filter((p) => p !== 'location:read'),
      };
      h.resolver.invalidate();
      expect(await lookup({ kind: 'location' }, 'MEMBER')).toMatchObject({
        ok: false,
        error: { code: 'FORBIDDEN', status: 403 },
      });
      expect((await lookup({ kind: 'assetModel' }, 'MEMBER')).ok).toBe(true);
      expect(
        await lookup({ kind: 'assetModel' }, 'SA with no grants'),
      ).toMatchObject({
        ok: false,
        error: { code: 'FORBIDDEN' },
      });
    });
  });

  describe('asset_model_create', () => {
    it('chat: previews the fields and the category, executes once on approval', async () => {
      const proposal = await h.tools.propose(
        'asset_model_create',
        {
          name: 'EliteBook 840',
          manufacturer: 'HP',
          category: 'laptops',
          specs: { ram: '16 GB' },
        },
        ctx(actor('MEMBER')),
      );
      if (!proposal.ok) throw new Error(JSON.stringify(proposal.result));
      const preview = proposal.action.preview;
      expect(AiActionPreviewSchema.safeParse(preview).success).toBe(true);
      expect(preview).toMatchObject({
        toolName: 'asset_model_create',
        class: 'write',
        changes: [
          { field: 'name', after: 'EliteBook 840' },
          { field: 'manufacturer', after: 'HP' },
          { field: 'specs', after: { ram: '16 GB' } },
          {
            field: 'category',
            after: { type: 'category', id: C.laptops, label: 'Laptops' },
            valueKind: 'entity',
          },
        ],
      });
      expect(preview).not.toHaveProperty('precondition');

      const approved = await h.tools.approve(
        proposal.action.id,
        ctx(actor('MEMBER')),
      );
      expect(approved).toMatchObject({
        status: 'SUCCEEDED',
        result: { ok: true, mutated: true },
      });
      expect(modelsService.create).toHaveBeenCalledTimes(1);
      expect(modelsService.create.mock.calls[0][0]).toEqual({
        name: 'EliteBook 840',
        manufacturer: 'HP',
        specs: { ram: '16 GB' },
        categoryId: C.laptops,
      });
      expect(events(proposal.action.id)).toEqual([
        'PROPOSED',
        'APPROVED',
        'EXECUTED',
      ]);
      expect(approved.result?.entityRefs).toEqual([
        expect.objectContaining({
          type: 'assetModel',
          op: 'created',
          label: 'EliteBook 840 (HP)',
        }),
      ]);
    });

    it('MCP within the ceiling executes; a VIEWER (no assetModel:write) is refused by the route', async () => {
      const result = await h.tools.invoke(
        'asset_model_create',
        { name: 'X1 Carbon', manufacturer: 'Lenovo', category: C.laptops },
        mcp(actor('MEMBER')),
      );
      expect(result).toMatchObject({ ok: true, mutated: true });
      const [row] = [...ai.invocations.values()];
      expect(events(row.id)).toEqual(['ATTEMPTED', 'EXECUTED']);
      // A raw category id passes straight through: no category read.
      expect(modelsService.create.mock.calls[0][0]).toMatchObject({
        categoryId: C.laptops,
      });

      const viewer = await h.tools.invoke(
        'asset_model_create',
        { name: 'Y', manufacturer: 'Z' },
        mcp(actor('VIEWER')),
      );
      expect(viewer).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
      expect(state.models.size).toBe(3);
    });
  });

  describe('location_create', () => {
    it('chat: previews the parent by name, creates it nested', async () => {
      const proposal = await h.tools.propose(
        'location_create',
        { name: 'Rack A', type: 'RACK', parent: 'hq' },
        ctx(actor('MEMBER')),
      );
      if (!proposal.ok) throw new Error(JSON.stringify(proposal.result));
      expect(proposal.action.preview).toMatchObject({
        changes: [
          { field: 'name', after: 'Rack A' },
          { field: 'type', after: 'RACK' },
          {
            field: 'parent',
            after: { type: 'location', id: L.hq, label: 'HQ' },
            valueKind: 'entity',
          },
        ],
      });
      const approved = await h.tools.approve(
        proposal.action.id,
        ctx(actor('MEMBER')),
      );
      expect(approved.status).toBe('SUCCEEDED');
      expect(locationsService.create.mock.calls[0][0]).toEqual({
        name: 'Rack A',
        type: 'RACK',
        parentId: L.hq,
      });
      expect(approved.result?.entityRefs).toEqual([
        expect.objectContaining({
          type: 'location',
          op: 'created',
          label: 'Rack A',
        }),
      ]);
    });

    it('an unknown parent fails the proposal; headless SA creates with a raw parent id', async () => {
      const unknown = await h.tools.propose(
        'location_create',
        { name: 'Rack B', type: 'RACK', parent: 'Mars' },
        ctx(actor('MEMBER')),
      );
      expect(unknown).toMatchObject({
        ok: false,
        result: { error: { code: 'NOT_FOUND' } },
      });

      const result = await h.tools.invoke(
        'location_create',
        { name: 'Rack C', type: 'RACK', parent: L.hq },
        ctx(actor('SA writer')),
      );
      expect(result).toMatchObject({ ok: true, mutated: true });
      expect(locationsService.create).toHaveBeenCalledTimes(1);
    });
  });
});
