import { NotFoundException } from '@nestjs/common';
import { ImportMappingSchema, type ImportMapping } from '@lazyit/shared';
import { ImportDryRunService } from './dry-run.service';
import type { PrismaService } from '../prisma/prisma.service';

// Stub the generated Prisma client so the test never loads the real one (no DB / no native engine).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

/**
 * Unit tests for the migrator DRY-RUN ENGINE (ADR-0069 wave 3, #631). Drives `analyze()` with fixture
 * rows + a mapping and a hand-rolled read-only Prisma double, asserting: coercion-under-mapping +
 * validation, value-deduped resolution (resolved once, not per row), model sku/name ambiguity with NO
 * auto-pick, category-via-model, the four conflict outcomes (match/restore/create + skip is operator),
 * the status value-map, asset-tag classification (explicit/auto-mint/collision), and — the headline
 * invariant — that the dry-run WRITES NOTHING to domain data.
 */

const OWNER = '11111111-1111-1111-1111-111111111111';

/** Parse a partial mapping so the schema defaults (enums/references → []) fire. */
function mapping(input: unknown): ImportMapping {
  return ImportMappingSchema.parse(input);
}

/**
 * A read-only Prisma double. Every query is a `findMany`/`findFirst` (reads); call counts are recorded
 * so a test can prove value-deduped resolution. `updateMany`/`create`/`update` are spies that FAIL the
 * test if a domain write happens (the dry-run must write nothing).
 */
function makePrisma(opts: {
  assetModel?: any[];
  location?: any[];
  assetByTag?: any[];
  schemeEnabled?: boolean;
  session?: any;
  writes?: { count: number };
}) {
  const writes = opts.writes ?? { count: 0 };
  const failOnWrite = () => {
    writes.count += 1;
    throw new Error('domain write attempted during dry-run');
  };
  return {
    _calls: { assetModel: 0, location: 0 },
    importSession: {
      findFirst: async () => opts.session ?? null,
      updateMany: async (args: any) => {
        // Allowed: the session's OWN transient state (resolutionPlan + status). NOT domain data.
        return { count: args?.where?.ownerId === OWNER ? 1 : 0 };
      },
    },
    assetModel: {
      findMany: async function (this: any) {
        (prisma as any)._calls.assetModel += 1;
        return opts.assetModel ?? [];
      },
      create: failOnWrite,
      update: failOnWrite,
    },
    location: {
      findMany: async () => {
        (prisma as any)._calls.location += 1;
        return opts.location ?? [];
      },
      create: failOnWrite,
      update: failOnWrite,
    },
    asset: {
      findMany: async () => opts.assetByTag ?? [],
      create: failOnWrite,
      update: failOnWrite,
    },
    assetTagScheme: {
      findFirst: async () => (opts.schemeEnabled ? { enabled: true } : null),
      update: failOnWrite,
      updateMany: failOnWrite,
    },
  } as unknown as PrismaService & { _calls: { assetModel: number; location: number } };
}

let prisma: any;

describe('ImportDryRunService.analyze — coercion + validation', () => {
  it('coerces under the mapping, validates, and counts valid/invalid rows', async () => {
    prisma = makePrisma({});
    const service = new ImportDryRunService(prisma);
    const m = mapping({
      columns: [
        { field: 'name', column: 'Name' },
        { field: 'status', column: 'State' },
      ],
    });
    const report = await service.analyze(
      [
        { rowIndex: 0, raw: { Name: 'Laptop', State: 'active' } },
        { rowIndex: 1, raw: { Name: '', State: 'active' } }, // missing required name → invalid
        { rowIndex: 2, raw: { Name: 'Server', State: 'frobnicated' } }, // bad enum → invalid
      ],
      m,
    );
    expect(report.result.counts).toMatchObject({ total: 3, valid: 1, invalid: 2 });
    expect(report.result.rows[0]).toMatchObject({ rowIndex: 0, status: 'valid' });
    expect(report.result.rows[1].status).toBe('invalid');
    expect(report.result.rows[1].errors[0].field).toBe('name');
    expect(report.result.rows[2].status).toBe('invalid');
    // the enum miss is surfaced as a field-level error (not silently defaulted)
    expect(report.result.rows[2].errors.some((e) => e.field === 'status')).toBe(true);
  });

  it('maps status synonyms via the descriptor value-map', async () => {
    prisma = makePrisma({});
    const service = new ImportDryRunService(prisma);
    const m = mapping({ columns: [{ field: 'name', column: 'N' }, { field: 'status', column: 'S' }] });
    const report = await service.analyze([{ rowIndex: 0, raw: { N: 'X', S: 'Retired' } }], m);
    expect(report.result.rows[0].status).toBe('valid');
  });
});

describe('ImportDryRunService.analyze — reference resolution (deduped, no auto-pick)', () => {
  const baseMapping = mapping({
    columns: [
      { field: 'name', column: 'Name' },
      { field: 'status', constant: 'active' },
    ],
    references: [{ field: 'modelId', column: 'Model' }],
  });

  it('resolves a distinct value ONCE across many rows (value-deduped, cached)', async () => {
    prisma = makePrisma({
      assetModel: [
        { id: 'm1', name: 'Latitude 5520', manufacturer: 'Dell', sku: null, deletedAt: null, category: { name: 'Laptops' } },
      ],
    });
    const service = new ImportDryRunService(prisma);
    const rows = Array.from({ length: 5 }, (_, i) => ({
      rowIndex: i,
      raw: { Name: `PC ${i}`, Model: 'Latitude 5520' },
    }));
    const report = await service.analyze(rows, baseMapping);
    // 5 rows share one model value → the model is resolved exactly ONCE.
    expect(prisma._calls.assetModel).toBe(1);
    expect(report.conflicts).toHaveLength(1);
    const c = report.conflicts[0];
    expect(c.rowCount).toBe(5);
    expect(c.suggested).toBe('match');
    expect(c.ambiguous).toBe(false);
    // category-via-model: the candidate surfaces the model's category.
    expect(c.candidates[0].categoryName).toBe('Laptops');
  });

  it('NEVER auto-picks on an ambiguous (N-candidate) model name match', async () => {
    prisma = makePrisma({
      assetModel: [
        { id: 'm1', name: 'XPS', manufacturer: 'Dell', sku: null, deletedAt: null, category: null },
        { id: 'm2', name: 'XPS', manufacturer: 'Dell', sku: null, deletedAt: null, category: null },
      ],
    });
    const service = new ImportDryRunService(prisma);
    const report = await service.analyze(
      [{ rowIndex: 0, raw: { Name: 'PC', Model: 'XPS' } }],
      baseMapping,
    );
    const c = report.conflicts[0];
    expect(c.candidates).toHaveLength(2);
    expect(c.ambiguous).toBe(true); // operator MUST choose — no auto-pick.
  });

  it('a sku-exact hit is preferred over the soft name match', async () => {
    prisma = makePrisma({
      assetModel: [
        { id: 'm1', name: 'OtherName', manufacturer: 'Dell', sku: 'SKU-1', deletedAt: null, category: null },
        { id: 'm2', name: 'SKU-1', manufacturer: 'HP', sku: null, deletedAt: null, category: null }, // matched the name only
      ],
    });
    const service = new ImportDryRunService(prisma);
    const report = await service.analyze(
      [{ rowIndex: 0, raw: { Name: 'PC', Model: 'SKU-1' } }],
      baseMapping,
    );
    const c = report.conflicts[0];
    expect(c.candidates).toHaveLength(1);
    expect(c.candidates[0].id).toBe('m1'); // the sku-exact match wins.
    expect(c.suggested).toBe('match');
  });

  it('a soft-deleted-only match surfaces as a RESTORE candidate (includeSoftDeleted)', async () => {
    prisma = makePrisma({
      assetModel: [
        { id: 'm-ghost', name: 'Ghosted', manufacturer: 'Dell', sku: null, deletedAt: new Date(), category: null },
      ],
    });
    const service = new ImportDryRunService(prisma);
    const report = await service.analyze(
      [{ rowIndex: 0, raw: { Name: 'PC', Model: 'Ghosted' } }],
      baseMapping,
    );
    const c = report.conflicts[0];
    expect(c.candidates[0].live).toBe(false);
    expect(c.suggested).toBe('restore');
    expect(c.ambiguous).toBe(false);
  });

  it('no candidate ⇒ CREATE-new is the outcome', async () => {
    prisma = makePrisma({ assetModel: [] });
    const service = new ImportDryRunService(prisma);
    const report = await service.analyze(
      [{ rowIndex: 0, raw: { Name: 'PC', Model: 'Brand New Model' } }],
      baseMapping,
    );
    expect(report.conflicts[0].suggested).toBe('create');
    expect(report.conflicts[0].candidates).toHaveLength(0);
  });

  it('a live match shadows a same-named ghost (preferLive)', async () => {
    prisma = makePrisma({
      assetModel: [
        { id: 'live', name: 'Dup', manufacturer: 'Dell', sku: null, deletedAt: null, category: null },
        { id: 'ghost', name: 'Dup', manufacturer: 'Dell', sku: null, deletedAt: new Date(), category: null },
      ],
    });
    const service = new ImportDryRunService(prisma);
    const report = await service.analyze(
      [{ rowIndex: 0, raw: { Name: 'PC', Model: 'Dup' } }],
      baseMapping,
    );
    const c = report.conflicts[0];
    expect(c.candidates).toHaveLength(1);
    expect(c.candidates[0].id).toBe('live');
    expect(c.suggested).toBe('match');
  });

  it('location resolves by exact (trim-only) name', async () => {
    prisma = makePrisma({ location: [{ id: 'loc1', name: 'HQ', deletedAt: null }] });
    const service = new ImportDryRunService(prisma);
    const m = mapping({
      columns: [{ field: 'name', column: 'N' }, { field: 'status', constant: 'active' }],
      references: [{ field: 'locationId', column: 'Loc' }],
    });
    const report = await service.analyze([{ rowIndex: 0, raw: { N: 'PC', Loc: ' HQ ' } }], m);
    expect(report.conflicts[0].entity).toBe('Location');
    expect(report.conflicts[0].normalizedValue).toBe('HQ'); // trimmed
    expect(report.conflicts[0].suggested).toBe('match');
  });
});

describe('ImportDryRunService.analyze — asset-tag classification', () => {
  const m = mapping({
    columns: [
      { field: 'name', column: 'Name' },
      { field: 'status', constant: 'active' },
      { field: 'assetTag', column: 'Tag' },
    ],
  });

  it('classifies an explicit tag and flags a LIVE collision (never silently dropped)', async () => {
    prisma = makePrisma({ assetByTag: [{ assetTag: 'IT-0001' }] });
    const service = new ImportDryRunService(prisma);
    const report = await service.analyze(
      [
        { rowIndex: 0, raw: { Name: 'A', Tag: 'IT-0001' } }, // collides with a live asset
        { rowIndex: 1, raw: { Name: 'B', Tag: 'IT-9999' } }, // free
      ],
      m,
    );
    expect(report.tags[0]).toMatchObject({ mode: 'explicit', tag: 'IT-0001', collision: true });
    expect(report.tags[1]).toMatchObject({ mode: 'explicit', tag: 'IT-9999', collision: false });
  });

  it('a tagless row is auto-mint when the scheme is enabled, else none', async () => {
    const noScheme = makePrisma({ schemeEnabled: false });
    const tagless = mapping({
      columns: [{ field: 'name', column: 'Name' }, { field: 'status', constant: 'active' }],
    });
    let report = await new ImportDryRunService(noScheme).analyze(
      [{ rowIndex: 0, raw: { Name: 'A' } }],
      tagless,
    );
    expect(report.tags[0].mode).toBe('none');

    const withScheme = makePrisma({ schemeEnabled: true });
    report = await new ImportDryRunService(withScheme).analyze(
      [{ rowIndex: 0, raw: { Name: 'A' } }],
      tagless,
    );
    expect(report.tags[0].mode).toBe('auto-mint');
  });
});

describe('ImportDryRunService — dry-run writes NOTHING + plumbing', () => {
  it('runs the full pipeline without a single domain write', async () => {
    const writes = { count: 0 };
    prisma = makePrisma({
      assetModel: [{ id: 'm1', name: 'M', manufacturer: 'Dell', sku: null, deletedAt: null, category: { name: 'C' } }],
      location: [{ id: 'l1', name: 'HQ', deletedAt: null }],
      assetByTag: [{ assetTag: 'T1' }],
      schemeEnabled: true,
      writes,
    });
    const m = mapping({
      columns: [
        { field: 'name', column: 'Name' },
        { field: 'status', constant: 'active' },
        { field: 'assetTag', column: 'Tag' },
      ],
      references: [
        { field: 'modelId', column: 'Model' },
        { field: 'locationId', column: 'Loc' },
      ],
    });
    await new ImportDryRunService(prisma).analyze(
      [{ rowIndex: 0, raw: { Name: 'PC', Tag: 'T1', Model: 'M', Loc: 'HQ' } }],
      m,
    );
    expect(writes.count).toBe(0); // headline invariant: zero domain writes.
  });

  it('dryRun reads the session owner-scoped and 404s for an unknown/foreign session', async () => {
    prisma = makePrisma({ session: null });
    const service = new ImportDryRunService(prisma);
    await expect(service.dryRun('sess_x', OWNER)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('dryRun 404s a session with no confirmed mapping', async () => {
    prisma = makePrisma({ session: { id: 's', mapping: null, rows: [] } });
    const service = new ImportDryRunService(prisma);
    await expect(service.dryRun('s', OWNER)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('dryRun runs analyze over the session rows under the persisted mapping', async () => {
    const m = mapping({ columns: [{ field: 'name', column: 'Name' }, { field: 'status', constant: 'active' }] });
    prisma = makePrisma({
      session: { id: 's', mapping: m, rows: [{ rowIndex: 0, raw: { Name: 'PC' } }] },
    });
    const report = await new ImportDryRunService(prisma).dryRun('s', OWNER);
    expect(report.result.counts.total).toBe(1);
    expect(report.result.rows[0].status).toBe('valid');
  });

  it('saveResolutionPlan persists to the session (owner-scoped) and 404s otherwise', async () => {
    prisma = makePrisma({});
    const service = new ImportDryRunService(prisma);
    await expect(
      service.saveResolutionPlan('s', OWNER, { conflicts: [] }),
    ).resolves.toBeUndefined();
    await expect(
      service.saveResolutionPlan('s', 'someone-else', { conflicts: [] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
