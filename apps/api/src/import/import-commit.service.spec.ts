import { NotFoundException } from '@nestjs/common';
import {
  ImportMappingSchema,
  ImportResolutionPlanSchema,
  type ImportMapping,
  type ImportResolutionPlan,
} from '@lazyit/shared';
import { ImportCommitService } from './import-commit.service';

// The commit service transitively imports the ESM `meilisearch` package (via AssetsService →
// SearchService); jest can't parse its ESM output, so stub the constructor (the spec injects a fake
// SearchService anyway). Mirrors the assets.service.spec pattern.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

// Stub the generated Prisma client so the spec never loads the real one (no DB / no native engine).
jest.mock('../../generated/prisma/client', () => {
  class PrismaClientKnownRequestError extends Error {
    code: string;
    meta?: Record<string, unknown>;
    constructor(message: string, opts: { code: string; meta?: Record<string, unknown> }) {
      super(message);
      this.code = opts.code;
      this.meta = opts.meta;
    }
  }
  return {
    PrismaClient: class {},
    Prisma: { PrismaClientKnownRequestError },
  };
});

import { Prisma } from '../../generated/prisma/client';

/**
 * Unit tests for the migrator COMMIT ENGINE (ADR-0069 wave 4a, #633). Drives `commit()` with fixture
 * rows + a frozen resolution plan against hand-rolled doubles, asserting the write-path contract:
 *   - creates each asset through `AssetsService.create()` with `{ source:'import', importRunId }` stamped
 *     into the CREATED event's provenance payload (NEVER createMany);
 *   - applies the plan per reference outcome — match (resolved FK) / create (memoized, once) / restore /
 *     skip (drop the link, keep the row);
 *   - the three asset-tag modes ride `create()` (explicit passes through; auto-mint is the scheme's job);
 *   - a mid-batch P2002/P2003 is a per-row FAILED row, NOT a batch abort (keep-partial);
 *   - re-running skips COMMITTED rows (resumable) and a doomed (invalid) row never reaches `create()`
 *     (so it can't burn a tag-scheme counter number — validate-before-allocate);
 *   - the append-only `ImportRun` ledger is written with PII-free counts + conflict summary;
 *   - per-row search upserts are SUPPRESSED during the bulk and ONE reconcile runs after.
 */

const OWNER = '11111111-1111-1111-1111-111111111111';

function mapping(input: unknown): ImportMapping {
  return ImportMappingSchema.parse(input);
}
function plan(input: unknown): ImportResolutionPlan {
  return ImportResolutionPlanSchema.parse(input);
}

/** A single source row as parsed/stored on `ImportRow`. */
interface FixtureRow {
  id: number;
  rowIndex: number;
  status: string;
  raw: Record<string, string>;
}

interface PrismaState {
  session: {
    id: string;
    entity: 'ASSET';
    mapping: unknown;
    resolutionPlan: unknown;
    fileHash: string | null;
    rows: FixtureRow[];
  } | null;
  user?: { id: string } | null;
}

/** A Prisma double recording every write so the spec can assert the contract. */
function makePrisma(state: PrismaState) {
  const rowStatuses = new Map<number, { status: string; error?: unknown }>();
  const runs: any[] = [];
  const sessionUpdates: any[] = [];
  let runIdSeq = 100;
  const assets: any[] = [];

  return {
    _rowStatuses: rowStatuses,
    _runs: runs,
    _sessionUpdates: sessionUpdates,
    _assets: assets,
    importSession: {
      findFirst: async (args: any) => {
        if (!state.session) return null;
        if (args.where.ownerId !== OWNER) return null;
        if (args.where.id !== state.session.id) return null;
        return state.session;
      },
      update: async (args: any) => {
        sessionUpdates.push(args.data);
        return {};
      },
      updateMany: async (args: any) => {
        sessionUpdates.push(args.data);
        return { count: 1 };
      },
    },
    importRun: {
      create: async (args: any) => {
        const run = { id: runIdSeq++, ...args.data };
        runs.push(run);
        return { id: run.id };
      },
      update: async (args: any) => {
        const run = runs.find((r) => r.id === args.where.id);
        if (run) Object.assign(run, args.data);
        return {};
      },
    },
    importRow: {
      update: async (args: any) => {
        rowStatuses.set(args.where.id, {
          status: args.data.status,
          error: args.data.error,
        });
        // Reflect the new status back onto the fixture so a resumability re-run sees it.
        const row = state.session?.rows.find((r) => r.id === args.where.id);
        if (row) row.status = args.data.status;
        return {};
      },
    },
    user: {
      findFirst: async () => state.user ?? { id: OWNER },
    },
    asset: {
      findMany: async () => assets,
    },
  };
}

/** A fake AssetsService recording every create() call + its provenance, with scripted failures. */
function makeAssets(opts?: { failOn?: (data: any) => unknown }) {
  const calls: { data: any; options: any }[] = [];
  let idSeq = 0;
  return {
    _calls: calls,
    create: jest.fn(async (data: any, _principal: any, options: any) => {
      calls.push({ data, options });
      const fail = opts?.failOn?.(data);
      if (fail) throw fail;
      const asset = { id: `asset-${idSeq++}`, ...data };
      return asset;
    }),
  };
}

/** cuid-shaped ids so the created FK passes `CreateAssetSchema`'s `z.cuid()` re-validation. */
function makeRefService(prefix: string) {
  let seq = 0;
  return {
    create: jest.fn(async (data: any) => ({
      id: `c${prefix}created000000000000${seq++}`,
      ...data,
    })),
    restore: jest.fn(async (id: string) => ({ id, deletedAt: null })),
  };
}

/** A search double with a REAL suppression counter, recording upserts + reconciles. */
function makeSearch(enabled = true) {
  let depth = 0;
  const upserts: any[] = [];
  const reconciles: any[] = [];
  return {
    _upserts: upserts,
    _reconciles: reconciles,
    get enabled() {
      return enabled;
    },
    runSuppressed: async (fn: () => Promise<any>) => {
      depth += 1;
      try {
        return await fn();
      } finally {
        depth -= 1;
      }
    },
    upsert: (_index: string, doc: any) => {
      if (depth > 0) return; // mirrors the real suppression gate
      upserts.push(doc);
    },
    rebuildIndex: async (_index: string, docs: any[]) => {
      reconciles.push(docs);
    },
  };
}

function makeService(state: PrismaState, doubles?: any) {
  const prisma = doubles?.prisma ?? makePrisma(state);
  const assets = doubles?.assets ?? makeAssets();
  const models = doubles?.models ?? makeRefService('model');
  const locations = doubles?.locations ?? makeRefService('location');
  const search = doubles?.search ?? makeSearch();
  const queue = { add: jest.fn(async () => ({})) };
  const service = new ImportCommitService(
    queue as any,
    prisma as any,
    assets as any,
    models as any,
    locations as any,
    search as any,
  );
  return { service, prisma, assets, models, locations, search, queue };
}

/** A minimal mapping: name+status by column, model+location as FK references. */
const ASSET_MAPPING = mapping({
  columns: [
    { field: 'name', column: 'Name' },
    { field: 'status', column: 'Status' },
  ],
  enums: [],
  references: [
    { field: 'modelId', column: 'Model' },
    { field: 'locationId', column: 'Location' },
  ],
});

function sessionWith(rows: FixtureRow[], resolutionPlan: ImportResolutionPlan): PrismaState {
  return {
    session: {
      id: 'sess-1',
      entity: 'ASSET',
      mapping: ASSET_MAPPING,
      resolutionPlan,
      fileHash: 'deadbeef',
      rows,
    },
  };
}

describe('ImportCommitService.commit', () => {
  it('creates each asset via AssetsService.create with import provenance + CREATED history path', async () => {
    const state = sessionWith(
      [
        { id: 1, rowIndex: 0, status: 'VALID', raw: { Name: 'Laptop A', Status: 'active' } },
        { id: 2, rowIndex: 1, status: 'VALID', raw: { Name: 'Laptop B', Status: 'retired' } },
      ],
      plan({ conflicts: [] }),
    );
    const { service, assets, prisma } = makeService(state);

    const result = await service.commit('sess-1', OWNER);

    expect(result.committed).toBe(2);
    expect(result.failed).toBe(0);
    expect(assets.create).toHaveBeenCalledTimes(2);
    // Every create stamps { source:'import', importRunId } into the CREATED event payload (§8).
    for (const call of assets._calls) {
      expect(call.options.createdPayload).toEqual({
        source: 'import',
        importRunId: result.importRunId,
      });
    }
    expect(assets._calls[0].data.status).toBe('OPERATIONAL');
    expect(assets._calls[1].data.status).toBe('RETIRED');
    expect(prisma._rowStatuses.get(1)?.status).toBe('COMMITTED');
    expect(prisma._rowStatuses.get(2)?.status).toBe('COMMITTED');
  });

  it('applies the plan: match → resolved FK, create → memoized once, skip → drops the link', async () => {
    const state = sessionWith(
      [
        { id: 1, rowIndex: 0, status: 'VALID', raw: { Name: 'A', Status: 'active', Model: 'SKU-1', Location: 'HQ' } },
        { id: 2, rowIndex: 1, status: 'VALID', raw: { Name: 'B', Status: 'active', Model: 'SKU-1', Location: 'HQ' } },
        { id: 3, rowIndex: 2, status: 'VALID', raw: { Name: 'C', Status: 'active', Model: 'SKU-NEW', Location: 'Annex' } },
      ],
      plan({
        conflicts: [
          { entity: 'AssetModel', field: 'modelId', normalizedValue: 'SKU-1', outcome: 'match', targetId: 'cmodelexisting00000000001' },
          { entity: 'AssetModel', field: 'modelId', normalizedValue: 'SKU-NEW', outcome: 'create', targetId: null },
          { entity: 'Location', field: 'locationId', normalizedValue: 'HQ', outcome: 'match', targetId: 'clocexisting000000000001' },
          { entity: 'Location', field: 'locationId', normalizedValue: 'Annex', outcome: 'skip', targetId: null },
        ],
      }),
    );
    const { service, assets, models, locations } = makeService(state);

    const result = await service.commit('sess-1', OWNER);

    expect(result.committed).toBe(3);
    // Row 1 & 2 reuse the SAME matched model FK (no create), proving the resolution is replayed.
    expect(assets._calls[0].data.modelId).toBe('cmodelexisting00000000001');
    expect(assets._calls[1].data.modelId).toBe('cmodelexisting00000000001');
    // Row 3's new model is CREATED exactly once (memoized), with the natural-key value as the name.
    expect(models.create).toHaveBeenCalledTimes(1);
    expect(models.create.mock.calls[0][0]).toEqual({ name: 'SKU-NEW', manufacturer: 'Unknown' });
    // Locations: 'HQ' matched (never created); 'Annex' was skip → the FK is OMITTED on row 3.
    expect(locations.create).not.toHaveBeenCalled();
    expect(assets._calls[0].data.locationId).toBe('clocexisting000000000001');
    expect(assets._calls[2].data.locationId).toBeUndefined();
    expect(assets._calls[2].data.modelId).toMatch(/^cmodelcreated/);
  });

  it('restore → restores the soft-deleted reference once and uses its id', async () => {
    const state = sessionWith(
      [{ id: 1, rowIndex: 0, status: 'VALID', raw: { Name: 'A', Status: 'active', Location: 'Ghost Room' } }],
      plan({
        conflicts: [
          { entity: 'Location', field: 'locationId', normalizedValue: 'Ghost Room', outcome: 'restore', targetId: 'cghostloc00000000000000001' },
        ],
      }),
    );
    const { service, assets, locations } = makeService(state);

    await service.commit('sess-1', OWNER);

    expect(locations.restore).toHaveBeenCalledWith('cghostloc00000000000000001');
    expect(assets._calls[0].data.locationId).toBe('cghostloc00000000000000001');
  });

  it('keep-partial: a mid-batch P2002 is a per-row FAILED row, the batch continues, COMMITTED rows persist', async () => {
    const state = sessionWith(
      [
        { id: 1, rowIndex: 0, status: 'VALID', raw: { Name: 'A', Status: 'active' } },
        { id: 2, rowIndex: 1, status: 'VALID', raw: { Name: 'COLLIDE', Status: 'active' } },
        { id: 3, rowIndex: 2, status: 'VALID', raw: { Name: 'C', Status: 'active' } },
      ],
      plan({ conflicts: [] }),
    );
    const p2002 = new Prisma.PrismaClientKnownRequestError('dupe', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: 'assets_serial_active_key' },
    });
    const assets = makeAssets({ failOn: (d) => (d.name === 'COLLIDE' ? p2002 : undefined) });
    const { service, prisma } = makeService(state, { assets });

    const result = await service.commit('sess-1', OWNER);

    expect(result.committed).toBe(2);
    expect(result.failed).toBe(1);
    expect(prisma._rowStatuses.get(1)?.status).toBe('COMMITTED');
    expect(prisma._rowStatuses.get(2)?.status).toBe('FAILED');
    expect(prisma._rowStatuses.get(3)?.status).toBe('COMMITTED'); // batch continued past the failure
    // PII-free reason — a code, never the colliding value.
    expect((prisma._rowStatuses.get(2)?.error as any).reason).toBe('unique-taken-since-preview');
  });

  it('a P2003 (missing reference since preview) is a per-row FAILED row, never a 500/abort', async () => {
    const state = sessionWith(
      [{ id: 1, rowIndex: 0, status: 'VALID', raw: { Name: 'A', Status: 'active' } }],
      plan({ conflicts: [] }),
    );
    const p2003 = new Prisma.PrismaClientKnownRequestError('fk', {
      code: 'P2003',
      clientVersion: 'test',
    });
    const assets = makeAssets({ failOn: () => p2003 });
    const { service, prisma } = makeService(state, { assets });

    const result = await service.commit('sess-1', OWNER);

    expect(result.failed).toBe(1);
    expect((prisma._rowStatuses.get(1)?.error as any).reason).toBe('reference-missing-since-preview');
  });

  it('resumable: a re-run skips COMMITTED rows (never re-creates them)', async () => {
    const state = sessionWith(
      [
        { id: 1, rowIndex: 0, status: 'COMMITTED', raw: { Name: 'A', Status: 'active' } },
        { id: 2, rowIndex: 1, status: 'VALID', raw: { Name: 'B', Status: 'active' } },
      ],
      plan({ conflicts: [] }),
    );
    const { service, assets } = makeService(state);

    const result = await service.commit('sess-1', OWNER);

    expect(result.committed).toBe(2); // both counted committed
    expect(assets.create).toHaveBeenCalledTimes(1); // but only the not-yet-committed row was created
    expect(assets._calls[0].data.name).toBe('B');
  });

  it('validate-before-allocate: a doomed (invalid) row is FAILED and never reaches create() (no burned tag)', async () => {
    const state = sessionWith(
      [
        // status maps to nothing valid → the row fails CreateAssetSchema BEFORE any create()/tag alloc.
        { id: 1, rowIndex: 0, status: 'VALID', raw: { Name: 'A', Status: 'frobnicated' } },
        { id: 2, rowIndex: 1, status: 'VALID', raw: { Name: 'B', Status: 'active' } },
      ],
      plan({ conflicts: [] }),
    );
    const { service, assets, prisma } = makeService(state);

    const result = await service.commit('sess-1', OWNER);

    expect(result.failed).toBe(1);
    expect(result.committed).toBe(1);
    expect(prisma._rowStatuses.get(1)?.status).toBe('FAILED');
    expect((prisma._rowStatuses.get(1)?.error as any).reason).toBe('validation');
    // create() was reached ONLY for the valid row — the doomed row never entered the tag allocator.
    expect(assets.create).toHaveBeenCalledTimes(1);
    expect(assets._calls[0].data.name).toBe('B');
  });

  it('writes the append-only ImportRun ledger with PII-free counts + conflict summary', async () => {
    const state = sessionWith(
      [
        { id: 1, rowIndex: 0, status: 'VALID', raw: { Name: 'A', Status: 'active', Location: 'HQ' } },
        { id: 2, rowIndex: 1, status: 'VALID', raw: { Name: 'B', Status: 'active', Location: 'New' } },
      ],
      plan({
        conflicts: [
          { entity: 'Location', field: 'locationId', normalizedValue: 'HQ', outcome: 'match', targetId: 'clocexisting000000000001' },
          { entity: 'Location', field: 'locationId', normalizedValue: 'New', outcome: 'create', targetId: null },
        ],
      }),
    );
    const { service, prisma } = makeService(state);

    const result = await service.commit('sess-1', OWNER);

    expect(prisma._runs).toHaveLength(1);
    const run = prisma._runs[0];
    expect(run.sessionId).toBe('sess-1');
    expect(run.actorId).toBe(OWNER);
    expect(run.fileHash).toBe('deadbeef');
    expect(run.entity).toBe('ASSET');
    // Final counts patched in (append-only INSERT-then-finalize of the same row).
    expect(run.counts).toEqual({ total: 2, committed: 2, failed: 0, skipped: 0 });
    expect(run.conflictSummary).toEqual({ match: 1, restore: 0, create: 1, skip: 0 });
    expect(result.importRunId).toBe(run.id);
    // The conflict summary carries NO source values — only outcome counts (PII-free).
    expect(JSON.stringify(run.conflictSummary)).not.toContain('HQ');
  });

  it('suppresses per-row search upserts during the bulk and runs ONE reconcile after', async () => {
    const state = sessionWith(
      [
        { id: 1, rowIndex: 0, status: 'VALID', raw: { Name: 'A', Status: 'active' } },
        { id: 2, rowIndex: 1, status: 'VALID', raw: { Name: 'B', Status: 'active' } },
      ],
      plan({ conflicts: [] }),
    );
    // The fake AssetsService doesn't call search.upsert (the real one does, inside runSuppressed);
    // assert no upsert escaped and exactly one reconcile ran.
    const { service, search } = makeService(state);

    await service.commit('sess-1', OWNER);

    expect(search._upserts).toHaveLength(0);
    expect(search._reconciles).toHaveLength(1);
  });

  it('advances the session COMMITTING → COMMITTED', async () => {
    const state = sessionWith(
      [{ id: 1, rowIndex: 0, status: 'VALID', raw: { Name: 'A', Status: 'active' } }],
      plan({ conflicts: [] }),
    );
    const { service, prisma } = makeService(state);

    await service.commit('sess-1', OWNER);

    const statuses = prisma._sessionUpdates.map((u: any) => u.status);
    expect(statuses).toContain('COMMITTING');
    expect(statuses).toContain('COMMITTED');
  });

  it('404s an unknown / non-owned session and one with no resolution plan', async () => {
    const { service } = makeService({ session: null });
    await expect(service.commit('nope', OWNER)).rejects.toBeInstanceOf(NotFoundException);

    const noPlan = sessionWith(
      [{ id: 1, rowIndex: 0, status: 'VALID', raw: { Name: 'A', Status: 'active' } }],
      plan({ conflicts: [] }),
    );
    noPlan.session!.resolutionPlan = null;
    const { service: svc2 } = makeService(noPlan);
    await expect(svc2.commit('sess-1', OWNER)).rejects.toBeInstanceOf(NotFoundException);
  });
});
