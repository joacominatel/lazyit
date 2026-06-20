import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
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
    status: string;
    entity: 'ASSET';
    mapping: unknown;
    resolutionPlan: unknown;
    fileHash: string | null;
    rows: FixtureRow[];
  } | null;
  user?: { id: string; role?: string } | null;
  /** Stand-in for AssetHistory rows the resume-detect probe (`assetExistsForRow`) looks up. */
  assetHistory?: { eventType: string; payload: Record<string, unknown> }[];
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
    // The resume-detect probe: matches a CREATED import event by (sessionId, rowIndex) (fix 2).
    assetHistory: {
      findFirst: async (args: any) => {
        const conds: any[] = args.where.AND ?? [];
        const want: Record<string, unknown> = {};
        for (const c of conds) want[c.payload.path[0]] = c.payload.equals;
        const hit = (state.assetHistory ?? []).find(
          (h) =>
            h.eventType === args.where.eventType &&
            h.payload.source === want.source &&
            h.payload.sessionId === want.sessionId &&
            h.payload.rowIndex === want.rowIndex,
        );
        return hit ? { id: 1 } : null;
      },
    },
    // Find-or-create natural-key probes (fix 3): default to "not found" so create() runs; a test can
    // seed an existing row by overriding these doubles.
    location: {
      findFirst: async () => null,
    },
    assetModel: {
      findFirst: async () => null,
    },
    // AssetCategory find-or-create probe (ADR-0069 REDESIGN §4.4): default "not found" so create() runs;
    // a test seeds an existing live category by overriding this double.
    assetCategory: {
      findFirst: async () => null,
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

/**
 * A search double recording upserts + reconciles. There is NO process-wide suppression here anymore
 * (it was retired — see fix 1): per-row suppression now rides `AssetsService.create({ suppressSearch })`,
 * so the commit service must never call `search.upsert` directly during the bulk; the reconcile runs
 * once after via `rebuildIndex`.
 */
function makeSearch(enabled = true) {
  const upserts: any[] = [];
  const reconciles: any[] = [];
  return {
    _upserts: upserts,
    _reconciles: reconciles,
    get enabled() {
      return enabled;
    },
    upsert: (_index: string, doc: any) => {
      upserts.push(doc);
    },
    rebuildIndex: async (_index: string, docs: any[]) => {
      reconciles.push(docs);
    },
  };
}

/**
 * A PermissionResolverService double for the runtime per-target AND-check (ADR-0069 §11). Defaults to
 * "allowed" (hasAll → true) so the existing commit/enqueue tests are unaffected; an authz test passes
 * `{ hasAll: jest.fn(...) }` to deny a specific permission set.
 */
function makePermissions(hasAll: (...args: any[]) => Promise<boolean> = async () => true) {
  return { hasAll: jest.fn(hasAll) };
}

/** A category double recording create() calls, with cuid-shaped ids (find-or-create §4.4). */
function makeCategories() {
  let seq = 0;
  return {
    create: jest.fn(async (data: any) => ({
      id: `ccategorycreated00000000${seq++}`,
      ...data,
    })),
  };
}

function makeService(state: PrismaState, doubles?: any) {
  const prisma = doubles?.prisma ?? makePrisma(state);
  const assets = doubles?.assets ?? makeAssets();
  const models = doubles?.models ?? makeRefService('model');
  const categories = doubles?.categories ?? makeCategories();
  const locations = doubles?.locations ?? makeRefService('location');
  const search = doubles?.search ?? makeSearch();
  const permissions = doubles?.permissions ?? makePermissions();
  const queue = {
    add: jest.fn(async (_name: string, _data: unknown, _opts: any) => ({})),
  };
  const service = new ImportCommitService(
    queue as any,
    prisma as any,
    assets as any,
    models as any,
    categories as any,
    locations as any,
    search as any,
    permissions as any,
  );
  return { service, prisma, assets, models, categories, locations, search, permissions, queue };
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

function sessionWith(
  rows: FixtureRow[],
  resolutionPlan: ImportResolutionPlan,
  status = 'DRY_RUN',
): PrismaState {
  return {
    session: {
      id: 'sess-1',
      status,
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
    // Every create stamps { source:'import', sessionId, rowIndex } into the CREATED event payload and
    // suppresses its own per-row search upsert (§8/§9/§10). The provenance uses the STABLE sessionId,
    // not the autoincrement run id (which doesn't exist until after the loop).
    assets._calls.forEach((call: { data: any; options: any }, i: number) => {
      expect(call.options.createdPayload).toEqual({
        source: 'import',
        sessionId: 'sess-1',
        rowIndex: i,
      });
      expect(call.options.suppressSearch).toBe(true);
    });
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
    // The real AssetsService suppresses its own per-row upsert when passed `suppressSearch:true`; the
    // commit service itself never upserts during the bulk. Assert no upsert escaped + one reconcile ran.
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

  // ===== Integrity fixes (wave-4a review) ======================================================

  it('resume: create() landed but markRow threw → the asset is NOT re-created (no duplicate) [fix 2]', async () => {
    // Simulate the dual-write window: row 0 was created in a prior attempt (its CREATED provenance
    // exists) but its markRow('COMMITTED') never landed, so the row is still 'VALID'. On resume the
    // commit must DETECT the existing asset and reconcile the row to COMMITTED — never re-create it.
    const state = sessionWith(
      [{ id: 1, rowIndex: 0, status: 'VALID', raw: { Name: 'A', Status: 'active' } }],
      plan({ conflicts: [] }),
    );
    state.assetHistory = [
      { eventType: 'CREATED', payload: { source: 'import', sessionId: 'sess-1', rowIndex: 0 } },
    ];
    const { service, assets, prisma } = makeService(state);

    const result = await service.commit('sess-1', OWNER);

    expect(assets.create).not.toHaveBeenCalled(); // no duplicate asset minted
    expect(result.committed).toBe(1);
    expect(result.failed).toBe(0);
    expect(prisma._rowStatuses.get(1)?.status).toBe('COMMITTED'); // row reconciled
  });

  it('commit() rejects a non-DRY_RUN session with ConflictException (no re-commit) [fix 4]', async () => {
    const committed = sessionWith(
      [{ id: 1, rowIndex: 0, status: 'COMMITTED', raw: { Name: 'A', Status: 'active' } }],
      plan({ conflicts: [] }),
      'COMMITTED',
    );
    const { service, prisma } = makeService(committed);

    await expect(service.commit('sess-1', OWNER)).rejects.toBeInstanceOf(ConflictException);
    // It never wrote a second ImportRun ledger row.
    expect(prisma._runs).toHaveLength(0);
  });

  it('enqueueCommit rejects a non-DRY_RUN session and never enqueues, with a deterministic jobId [fix 4]', async () => {
    const committed = sessionWith(
      [{ id: 1, rowIndex: 0, status: 'COMMITTED', raw: { Name: 'A', Status: 'active' } }],
      plan({ conflicts: [] }),
      'COMMITTED',
    );
    const { service, queue } = makeService(committed);

    await expect(service.enqueueCommit('sess-1', OWNER)).rejects.toBeInstanceOf(ConflictException);
    expect(queue.add).not.toHaveBeenCalled();

    // A DRY_RUN session DOES enqueue, with jobId === sessionId (BullMQ dedup of concurrent enqueues).
    const dryRun = sessionWith(
      [{ id: 1, rowIndex: 0, status: 'VALID', raw: { Name: 'A', Status: 'active' } }],
      plan({ conflicts: [] }),
    );
    const { service: svc2, queue: q2 } = makeService(dryRun);
    await svc2.enqueueCommit('sess-1', OWNER);
    expect(q2.add).toHaveBeenCalledTimes(1);
    expect(q2.add.mock.calls[0][2].jobId).toBe('sess-1');
  });

  // ── Runtime per-target authz AND-check at commit (ADR-0069 §11) ────────────────────────────────
  describe('enqueueCommit runtime per-target permission AND-check', () => {
    it('always requires asset:write — denies (403) and never enqueues when the actor lacks it', async () => {
      const dryRun = sessionWith(
        [{ id: 1, rowIndex: 0, status: 'VALID', raw: { Name: 'A', Status: 'active' } }],
        plan({ conflicts: [] }),
      );
      // The actor holds import:run (route guard, not modeled here) but NOT asset:write.
      const permissions = makePermissions(async (_role, required: string[]) => {
        return !required.includes('asset:write');
      });
      const { service, queue } = makeService(dryRun, { permissions });

      await expect(service.enqueueCommit('sess-1', OWNER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(queue.add).not.toHaveBeenCalled();
      // The AND-check asked for exactly asset:write (no create/restore conflicts in this plan).
      expect(permissions.hasAll).toHaveBeenCalledTimes(1);
      const required = permissions.hasAll.mock.calls[0][1] as string[];
      expect([...required].sort()).toEqual(['asset:write']);
    });

    it('requires the reference write for each create/restore conflict (assetModel:write + location:write)', async () => {
      const dryRun = sessionWith(
        [{ id: 1, rowIndex: 0, status: 'VALID', raw: { Name: 'A', Status: 'active' } }],
        plan({
          conflicts: [
            { entity: 'AssetModel', field: 'modelId', normalizedValue: 'X1', outcome: 'create', targetId: null },
            { entity: 'Location', field: 'locationId', normalizedValue: 'HQ', outcome: 'restore', targetId: 'cloc000000000000000000001' },
            // A `match` outcome links an existing live row → no write needed, so it must NOT be required.
            { entity: 'Location', field: 'locationId', normalizedValue: 'Lab', outcome: 'match', targetId: 'cloc000000000000000000002' },
          ],
        }),
      );
      const permissions = makePermissions(async () => true);
      const { service, queue } = makeService(dryRun, { permissions });

      await service.enqueueCommit('sess-1', OWNER);

      expect(queue.add).toHaveBeenCalledTimes(1);
      const required = permissions.hasAll.mock.calls[0][1] as string[];
      expect([...required].sort()).toEqual(
        ['asset:write', 'assetModel:write', 'location:write'].sort(),
      );
    });

    it('denies (403) when the actor holds asset:write but not the reference write a create needs', async () => {
      const dryRun = sessionWith(
        [{ id: 1, rowIndex: 0, status: 'VALID', raw: { Name: 'A', Status: 'active' } }],
        plan({
          conflicts: [
            { entity: 'AssetModel', field: 'modelId', normalizedValue: 'X1', outcome: 'create', targetId: null },
          ],
        }),
      );
      // Holds everything EXCEPT assetModel:write.
      const permissions = makePermissions(async (_role, required: string[]) => {
        return !required.includes('assetModel:write');
      });
      const { service, queue } = makeService(dryRun, { permissions });

      await expect(service.enqueueCommit('sess-1', OWNER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('fails closed (403) when the actor user is missing/deleted', async () => {
      const dryRun = sessionWith(
        [{ id: 1, rowIndex: 0, status: 'VALID', raw: { Name: 'A', Status: 'active' } }],
        plan({ conflicts: [] }),
      );
      const prisma = makePrisma(dryRun);
      prisma.user.findFirst = (async () => null) as never; // actor no longer exists
      const { service, queue } = makeService(dryRun, { prisma });

      await expect(service.enqueueCommit('sess-1', OWNER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  it('ImportRun counts are never zeroed/stale after a mid-batch throw (ledger written once, after the loop) [fix 5]', async () => {
    const state = sessionWith(
      [
        { id: 1, rowIndex: 0, status: 'VALID', raw: { Name: 'A', Status: 'active' } },
        { id: 2, rowIndex: 1, status: 'VALID', raw: { Name: 'B', Status: 'active' } },
      ],
      plan({ conflicts: [] }),
    );
    const prisma = makePrisma(state);
    // Force an UNEXPECTED orchestration fault mid-batch: the row-status write throws on row 2. The
    // catch path's markRow throws too, so the fault escapes the loop and commit() rejects.
    const realUpdate = prisma.importRow.update;
    prisma.importRow.update = async (args: any) => {
      if (args.where.id === 2) throw new Error('db blip mid-batch');
      return realUpdate(args);
    };
    const { service } = makeService(state, { prisma });

    await expect(service.commit('sess-1', OWNER)).rejects.toThrow('db blip mid-batch');
    // The ledger is written ONCE, AFTER the loop — a mid-batch throw means it is NEVER written, so
    // there is no row left holding misleading zeroed counts (true append-only, ADR-0006).
    expect(prisma._runs).toHaveLength(0);
  });

  it('createReference is find-or-create: an existing live ref by natural key is reused, not re-created [fix 3]', async () => {
    const state = sessionWith(
      [{ id: 1, rowIndex: 0, status: 'VALID', raw: { Name: 'A', Status: 'active', Location: 'HQ' } }],
      plan({
        conflicts: [
          { entity: 'Location', field: 'locationId', normalizedValue: 'HQ', outcome: 'create', targetId: null },
        ],
      }),
    );
    const prisma = makePrisma(state);
    // A live Location named 'HQ' already exists (e.g. created by a prior retried run) — find-or-create
    // must REUSE it rather than minting a duplicate (Location.name is not unique, so nothing else would
    // stop the dupe). Idempotency across the attempts:3 retry budget (ADR-0069 §9).
    prisma.location.findFirst = (async () => ({
      id: 'clocexistinghq0000000001',
    })) as unknown as typeof prisma.location.findFirst;
    const { service, assets, locations } = makeService(state, { prisma });

    const result = await service.commit('sess-1', OWNER);

    expect(result.committed).toBe(1);
    expect(locations.create).not.toHaveBeenCalled(); // reused, not re-created
    expect(assets._calls[0].data.locationId).toBe('clocexistinghq0000000001');
  });

  // ===== Etapa 1: real Model manufacturer + category, find-or-create category, specs ===========

  /** A mapping that maps name/status, model as an FK ref, plus a modelConfig (manufacturer+category). */
  const MODEL_CONFIG_MAPPING = mapping({
    columns: [
      { field: 'name', column: 'Name' },
      { field: 'status', column: 'Status' },
    ],
    enums: [],
    references: [{ field: 'modelId', column: 'Model' }],
    modelConfig: {
      manufacturerColumn: 'Manufacturer',
      categoryColumn: 'Category',
    },
  });

  function sessionWithMapping(
    rows: FixtureRow[],
    resolutionPlan: ImportResolutionPlan,
    mappingBlob: ImportMapping,
  ): PrismaState {
    return {
      session: {
        id: 'sess-1',
        status: 'DRY_RUN',
        entity: 'ASSET',
        mapping: mappingBlob,
        resolutionPlan,
        fileHash: 'deadbeef',
        rows,
      },
    };
  }

  it('createReference creates a Model with the REAL manufacturer + category from modelConfig [§4.4]', async () => {
    const state = sessionWithMapping(
      [
        {
          id: 1,
          rowIndex: 0,
          status: 'VALID',
          raw: { Name: 'A', Status: 'active', Model: 'MacBook Pro', Manufacturer: 'Apple', Category: 'Laptop' },
        },
      ],
      plan({
        conflicts: [
          { entity: 'AssetModel', field: 'modelId', normalizedValue: 'MacBook Pro', outcome: 'create', targetId: null },
        ],
      }),
      MODEL_CONFIG_MAPPING,
    );
    const { service, models, categories, assets } = makeService(state);

    const result = await service.commit('sess-1', OWNER);

    expect(result.committed).toBe(1);
    // The category is find-or-created first (none existed → created once), then its id rides the model.
    expect(categories.create).toHaveBeenCalledTimes(1);
    expect(categories.create.mock.calls[0][0]).toEqual({ name: 'Laptop' });
    expect(models.create).toHaveBeenCalledTimes(1);
    expect(models.create.mock.calls[0][0]).toEqual({
      name: 'MacBook Pro',
      manufacturer: 'Apple',
      categoryId: 'ccategorycreated000000000',
    });
    expect(assets._calls[0].data.modelId).toMatch(/^cmodelcreated/);
  });

  it('falls back to the Unknown manufacturer and OMITS category when modelConfig has neither [§4.4]', async () => {
    const state = sessionWithMapping(
      [{ id: 1, rowIndex: 0, status: 'VALID', raw: { Name: 'A', Status: 'active', Model: 'Mystery' } }],
      plan({
        conflicts: [
          { entity: 'AssetModel', field: 'modelId', normalizedValue: 'Mystery', outcome: 'create', targetId: null },
        ],
      }),
      // A mapping with NO modelConfig at all.
      mapping({
        columns: [
          { field: 'name', column: 'Name' },
          { field: 'status', column: 'Status' },
        ],
        references: [{ field: 'modelId', column: 'Model' }],
      }),
    );
    const { service, models, categories } = makeService(state);

    await service.commit('sess-1', OWNER);

    expect(categories.create).not.toHaveBeenCalled();
    expect(models.create.mock.calls[0][0]).toEqual({ name: 'Mystery', manufacturer: 'Unknown' });
  });

  it('AssetCategory find-or-create is idempotent: two models, same category name → ONE category [§4.4]', async () => {
    const state = sessionWithMapping(
      [
        {
          id: 1,
          rowIndex: 0,
          status: 'VALID',
          raw: { Name: 'A', Status: 'active', Model: 'Model One', Manufacturer: 'Dell', Category: 'Laptop' },
        },
        {
          id: 2,
          rowIndex: 1,
          status: 'VALID',
          raw: { Name: 'B', Status: 'active', Model: 'Model Two', Manufacturer: 'HP', Category: 'Laptop' },
        },
      ],
      plan({
        conflicts: [
          { entity: 'AssetModel', field: 'modelId', normalizedValue: 'Model One', outcome: 'create', targetId: null },
          { entity: 'AssetModel', field: 'modelId', normalizedValue: 'Model Two', outcome: 'create', targetId: null },
        ],
      }),
      MODEL_CONFIG_MAPPING,
    );
    const prisma = makePrisma(state);
    // After the first row creates the 'Laptop' category, the find-first must SEE it on the second row so
    // it reuses the same id instead of minting a duplicate (the cross-/within-run idempotency window).
    let created: { id: string } | null = null;
    const realCreate = (id: string) => {
      created = { id };
    };
    prisma.assetCategory.findFirst = (async () => created) as never;
    const categories = makeCategories();
    categories.create = jest.fn(async (data: any) => {
      const row = { id: 'ccategorylaptop0000000001', ...data };
      realCreate(row.id);
      return row;
    }) as never;
    const { service, models } = makeService(state, { prisma, categories });

    const result = await service.commit('sess-1', OWNER);

    expect(result.committed).toBe(2);
    // Two DISTINCT models created, but the 'Laptop' category created exactly ONCE (find-or-create).
    expect(models.create).toHaveBeenCalledTimes(2);
    expect(categories.create).toHaveBeenCalledTimes(1);
    // Both models point at the SAME (reused) category id.
    expect(models.create.mock.calls[0][0].categoryId).toBe('ccategorylaptop0000000001');
    expect(models.create.mock.calls[1][0].categoryId).toBe('ccategorylaptop0000000001');
  });

  it('reuses an EXISTING live category by name (no duplicate) when one is already present [§4.4]', async () => {
    const state = sessionWithMapping(
      [
        {
          id: 1,
          rowIndex: 0,
          status: 'VALID',
          raw: { Name: 'A', Status: 'active', Model: 'Srv1', Manufacturer: 'Dell', Category: 'Server' },
        },
      ],
      plan({
        conflicts: [
          { entity: 'AssetModel', field: 'modelId', normalizedValue: 'Srv1', outcome: 'create', targetId: null },
        ],
      }),
      MODEL_CONFIG_MAPPING,
    );
    const prisma = makePrisma(state);
    prisma.assetCategory.findFirst = (async () => ({
      id: 'ccategoryexistingsrv00001',
    })) as never;
    const { service, models, categories } = makeService(state, { prisma });

    await service.commit('sess-1', OWNER);

    expect(categories.create).not.toHaveBeenCalled(); // reused the live one
    expect(models.create.mock.calls[0][0].categoryId).toBe('ccategoryexistingsrv00001');
  });

  it('persists custom fields to Asset.specs (omit-empty, never {}) and null-proto at the write site [§4.3]', async () => {
    const state = sessionWithMapping(
      [
        // Row 1 has a RAM cell → specs.ram; row 2's RAM cell is blank → NO specs at all (omit-empty).
        { id: 1, rowIndex: 0, status: 'VALID', raw: { Name: 'A', Status: 'active', RAM: '16GB' } },
        { id: 2, rowIndex: 1, status: 'VALID', raw: { Name: 'B', Status: 'active', RAM: '' } },
      ],
      plan({ conflicts: [] }),
      mapping({
        columns: [
          { field: 'name', column: 'Name' },
          { field: 'status', column: 'Status' },
        ],
        custom: [{ column: 'RAM', key: 'ram' }],
      }),
    );
    const { service, assets } = makeService(state);

    const result = await service.commit('sess-1', OWNER);

    expect(result.committed).toBe(2);
    // Row 1: specs carries the custom key with the cell value (the value the strict CreateAssetSchema
    // revalidated and passed through to create()).
    expect(assets._calls[0].data.specs).toEqual({ ram: '16GB' });
    // Row 2: an empty cell never emits specs — the key is ABSENT (so CreateAssetSchema.specs.optional()
    // fires), never an empty {}.
    expect('specs' in assets._calls[1].data).toBe(false);
    // The global prototype is never polluted by the specs write path (null-proto build + reserved-key
    // skip, ADR-0069 REDESIGN §4.3). (The object create() receives is zod's re-validated copy; the
    // pollution vector was neutralized at the null-proto build site before validation.)
    expect(({} as Record<string, unknown>).ram).toBeUndefined();
  });
});
