import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Mock the generated Prisma client (no DB). `isUniqueTagCollision` does a real instanceof against
// Prisma.PrismaClientKnownRequestError, so the factory defines that class (defined INSIDE the factory
// — jest.mock is hoisted, so an outer reference would hit the TDZ). The tests grab the class back via
// the mocked module so they construct genuine instances.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {
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

import { Prisma } from '../../generated/prisma/client';
import {
  AssetTagSchemeService,
  isUniqueTagCollision,
  nextFreeNumber,
} from './asset-tag-scheme.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { ActorService } from '../common/actor.service';

// The P2002 factory the collision tests throw — a genuine instance of the mocked known-error class.
// `meta.target` carries the index/column that raised the conflict, so the guard can be exercised for
// real (an assetTag collision retries; a serial collision must NOT).
const FakePrismaKnownError =
  Prisma.PrismaClientKnownRequestError as unknown as new (
    code: string,
    meta?: { target?: string | string[] },
  ) => Error & { code: string; meta?: { target?: string | string[] } };

type SchemeMock = {
  findFirst: jest.Mock;
  upsert: jest.Mock;
  update: jest.Mock;
  updateMany: jest.Mock;
};

type AssetMock = {
  findMany: jest.Mock;
  count: jest.Mock;
  update: jest.Mock;
};

// The shape of the upsert() arg, so the assertions stay type-safe (no-unsafe-member-access).
type UpsertArg = {
  where: { id: string };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
};

// A simple in-memory model of the singleton counter so the skip-existing tests exercise the REAL
// jump+consume sequence (updateMany then atomic increment) against a live value, not just call counts.
function schemeRow(over: Record<string, unknown> = {}) {
  return {
    id: AssetTagSchemeService.SINGLETON_ID,
    enabled: true,
    prefix: 'IT-',
    suffix: null,
    width: null,
    nextNumber: 1000,
    ...over,
  };
}

describe('AssetTagSchemeService', () => {
  let service: AssetTagSchemeService;
  let assetTagScheme: SchemeMock;
  let asset: AssetMock;
  let history: { record: jest.Mock };
  let actor: ActorService;
  // The mutable counter the skip-existing tests drive through findFirst/updateMany/update.
  let counter: number;

  const SINGLETON = AssetTagSchemeService.SINGLETON_ID;

  beforeEach(async () => {
    counter = 1000;
    assetTagScheme = {
      findFirst: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    };
    asset = {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn(),
    };
    history = { record: jest.fn() };
    actor = new ActorService();
    const prisma = {
      assetTagScheme,
      asset,
      // create/update/remove pass a CALLBACK (interactive tx). Run it with the same delegates.
      $transaction: jest.fn((arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (c: unknown) => unknown)({ asset, assetHistory: {} })
          : Promise.all(arg as Array<Promise<unknown>>),
      ),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AssetTagSchemeService,
        { provide: PrismaService, useValue: prisma },
        { provide: AssetHistoryService, useValue: history },
        { provide: ActorService, useValue: actor },
      ],
    }).compile();
    service = moduleRef.get(AssetTagSchemeService);
  });

  /**
   * Wire the singleton-counter mocks so the skip-existing jump+consume runs end-to-end:
   *   - findFirst returns the scheme row carrying the CURRENT counter value.
   *   - updateMany (the forward JUMP) advances the in-memory counter to its target.
   *   - update (the atomic CONSUME) increments and returns the POST-increment value.
   * `occupiedTags` are the live tags the pre-skip parses to build the occupied set.
   */
  function wireCounter(occupiedTags: string[], scheme = schemeRow()) {
    assetTagScheme.findFirst.mockImplementation(() =>
      Promise.resolve({ ...scheme, nextNumber: counter }),
    );
    asset.findMany.mockImplementation((args: { select?: unknown }) => {
      // The occupied-scan select asks for { assetTag: true } only; everything else is a backfill read.
      const sel = args.select as Record<string, unknown> | undefined;
      if (sel && Object.keys(sel).length === 1 && 'assetTag' in sel) {
        return Promise.resolve(occupiedTags.map((assetTag) => ({ assetTag })));
      }
      return Promise.resolve([]);
    });
    assetTagScheme.updateMany.mockImplementation(
      (args: { where: { nextNumber: { lt: number } }; data: { nextNumber: number } }) => {
        if (counter < args.data.nextNumber) counter = args.data.nextNumber;
        return Promise.resolve({ count: 1 });
      },
    );
    assetTagScheme.update.mockImplementation(() => {
      counter += 1;
      return Promise.resolve({ nextNumber: counter });
    });
  }

  // --- getScheme ----------------------------------------------------------
  it('getScheme returns the explicit UNSET/DISABLED default when no row exists (never 404)', async () => {
    assetTagScheme.findFirst.mockResolvedValue(null);

    const scheme = await service.getScheme();

    expect(scheme.enabled).toBe(false);
    expect(scheme.prefix).toBeNull();
    expect(scheme.suffix).toBeNull();
    expect(scheme.width).toBeNull();
    expect(scheme.nextNumber).toBe(1);
    expect(assetTagScheme.findFirst).toHaveBeenCalledWith({
      where: { id: SINGLETON },
    });
  });

  it('getScheme maps a persisted row to the wire shape (Dates -> ISO)', async () => {
    const now = new Date('2026-06-16T00:00:00.000Z');
    assetTagScheme.findFirst.mockResolvedValue({
      id: SINGLETON,
      prefix: 'LAZY-',
      suffix: null,
      width: 5,
      nextNumber: 42,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });

    const scheme = await service.getScheme();

    expect(scheme).toEqual({
      prefix: 'LAZY-',
      suffix: null,
      width: 5,
      nextNumber: 42,
      enabled: true,
      createdAt: '2026-06-16T00:00:00.000Z',
      updatedAt: '2026-06-16T00:00:00.000Z',
    });
  });

  // --- updateScheme -------------------------------------------------------
  it('updateScheme upserts the singleton; startNumber seeds nextNumber on create', async () => {
    const now = new Date();
    assetTagScheme.upsert.mockResolvedValue({
      id: SINGLETON,
      prefix: 'IT-',
      suffix: null,
      width: 4,
      nextNumber: 1000,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });

    await service.updateScheme({
      enabled: true,
      prefix: 'IT-',
      width: 4,
      startNumber: 1000,
    });

    const calls = assetTagScheme.upsert.mock.calls as Array<[UpsertArg]>;
    const arg = calls[0][0];
    expect(arg.where).toEqual({ id: SINGLETON });
    expect(arg.create.nextNumber).toBe(1000);
    expect(arg.create.suffix).toBeNull(); // omitted affix persists as NULL
    // startNumber supplied → the update branch re-seeds the counter.
    expect(arg.update.nextNumber).toBe(1000);
  });

  it('updateScheme leaves the counter untouched on update when startNumber is omitted', async () => {
    const now = new Date();
    assetTagScheme.upsert.mockResolvedValue({
      id: SINGLETON,
      prefix: null,
      suffix: null,
      width: null,
      nextNumber: 7,
      enabled: false,
      createdAt: now,
      updatedAt: now,
    });

    await service.updateScheme({ enabled: false });

    const calls = assetTagScheme.upsert.mock.calls as Array<[UpsertArg]>;
    const arg = calls[0][0];
    expect(arg.update).not.toHaveProperty('nextNumber'); // counter left where it is
    expect(arg.create.nextNumber).toBe(1); // first-create default
  });

  // --- allocateTag --------------------------------------------------------
  it('allocateTag returns undefined for an EXPLICIT tag (explicit wins; counter untouched)', async () => {
    const result = await service.allocateTag('MANUAL-1');

    expect(result).toBeUndefined();
    expect(assetTagScheme.findFirst).not.toHaveBeenCalled();
    expect(assetTagScheme.update).not.toHaveBeenCalled();
  });

  it('allocateTag returns undefined when no scheme is configured (OFF by default)', async () => {
    assetTagScheme.findFirst.mockResolvedValue(null);

    const result = await service.allocateTag(undefined);

    expect(result).toBeUndefined();
    expect(assetTagScheme.update).not.toHaveBeenCalled();
  });

  it('allocateTag returns undefined when the scheme is disabled (counter untouched)', async () => {
    assetTagScheme.findFirst.mockResolvedValue({
      id: SINGLETON,
      enabled: false,
      prefix: 'LAZY-',
      suffix: null,
      width: 5,
      nextNumber: 42,
    });

    const result = await service.allocateTag(undefined);

    expect(result).toBeUndefined();
    expect(assetTagScheme.update).not.toHaveBeenCalled();
  });

  it('allocateTag atomically increments and renders prefix + zeroPad + suffix when enabled', async () => {
    assetTagScheme.findFirst.mockResolvedValue({
      id: SINGLETON,
      enabled: true,
      prefix: 'LAZY-',
      suffix: '-X',
      width: 5,
      nextNumber: 42,
    });
    // The update returns the POST-increment value (43); the allocated number is 42.
    assetTagScheme.update.mockResolvedValue({ nextNumber: 43 });

    const result = await service.allocateTag(undefined);

    expect(assetTagScheme.update).toHaveBeenCalledWith({
      where: { id: SINGLETON },
      data: { nextNumber: { increment: 1 } },
    });
    expect(result).toBe('LAZY-00042-X');
  });

  // --- skip-existing invariant (ADR-0068 §1) ------------------------------

  it('SKIP-EXISTING: dense occupancy 1000,1002,1005 → allocations 1001,1003,1004,1006…', async () => {
    // The CEO's exact example. The estate already has IT-1000, IT-1002, IT-1005; the counter starts at
    // 1000. Each allocation must land on the next FREE number — never a tag that already exists.
    wireCounter(['IT-1000', 'IT-1002', 'IT-1005']);

    const allocations: (string | undefined)[] = [];
    for (let i = 0; i < 4; i++) {
      allocations.push(await service.allocateTag(undefined));
    }

    // 1000 occupied → 1001; 1002 occupied → 1003; 1004 free → 1004; 1005 occupied → 1006.
    expect(allocations).toEqual(['IT-1001', 'IT-1003', 'IT-1004', 'IT-1006']);
  });

  it('SKIP-EXISTING jumps PAST a contiguous occupied block in one updateMany (no per-number P2002)', async () => {
    // A dense block 1000..1009 occupied; the first free slot is 1010. The pre-skip must JUMP straight
    // there with a single forward updateMany — not spin one collision at a time (the false-409 risk).
    const block = Array.from({ length: 10 }, (_, i) => `IT-${1000 + i}`);
    wireCounter(block);

    const first = await service.allocateTag(undefined);

    expect(first).toBe('IT-1010');
    // Exactly one forward jump to 1010, then one atomic consume — the block was skipped in one shot.
    expect(assetTagScheme.updateMany).toHaveBeenCalledTimes(1);
    expect(assetTagScheme.updateMany).toHaveBeenCalledWith({
      where: { id: SINGLETON, nextNumber: { lt: 1010 } },
      data: { nextNumber: 1010 },
    });
  });

  it('CONCURRENCY backstop: distinct atomic increments never hand two creates the same number', async () => {
    // Two creates probe the SAME free slot (1000, nothing occupied). The pre-skip jump is a no-op
    // (already at 1000); the atomic increment is what guarantees distinctness — each caller gets a
    // different post-increment value, so the rendered tags differ (1000 vs 1001). No duplicate.
    wireCounter([]);

    const [a, b] = await Promise.all([
      service.allocateTag(undefined),
      service.allocateTag(undefined),
    ]);

    expect(new Set([a, b]).size).toBe(2);
    expect([a, b].sort()).toEqual(['IT-1000', 'IT-1001']);
  });

  // --- seed suggestion (ADR-0068 §2) --------------------------------------

  it('seedSuggestion returns max(existing matching) + 1 and the matched count', async () => {
    // Live tags: IT-1000, IT-1002, IT-1005 match the in-progress affixes; LAB-1 and IT-ABC do NOT
    // (wrong prefix / non-numeric middle) and must be ignored.
    asset.findMany.mockResolvedValue([
      { assetTag: 'IT-1000' },
      { assetTag: 'IT-1002' },
      { assetTag: 'IT-1005' },
      { assetTag: 'LAB-1' },
      { assetTag: 'IT-ABC' },
    ]);

    const result = await service.seedSuggestion({ prefix: 'IT-' });

    expect(result).toEqual({
      suggestedStartNumber: 1006,
      matchedCount: 3,
      maxExistingNumber: 1005,
    });
  });

  it('seedSuggestion suggests 1 when nothing matches the affixes', async () => {
    asset.findMany.mockResolvedValue([{ assetTag: 'LAB-7' }, { assetTag: 'OTHER' }]);

    const result = await service.seedSuggestion({ prefix: 'IT-' });

    expect(result).toEqual({
      suggestedStartNumber: 1,
      matchedCount: 0,
      maxExistingNumber: null,
    });
  });

  // --- backfill: selection + apply + audit (ADR-0068 §3/§4) ---------------

  it('backfillApply (untagged-only) tags ONLY untagged assets, writes an AssetHistory row each', async () => {
    const scheme = schemeRow({ nextNumber: 1000 });
    // The affected-set read: two untagged live assets (selection done in SQL for this mode).
    const affected = [
      { id: 'a1', name: 'SRV-1', serial: null, assetTag: null, modelId: null, model: null },
      { id: 'a2', name: 'SRV-2', serial: null, assetTag: null, modelId: null, model: null },
    ];
    let findManyCall = 0;
    assetTagScheme.findFirst.mockImplementation(() =>
      Promise.resolve({ ...scheme, nextNumber: counter }),
    );
    asset.findMany.mockImplementation((args: { select?: Record<string, unknown> }) => {
      const sel = args.select;
      if (sel && Object.keys(sel).length === 1 && 'assetTag' in sel) {
        return Promise.resolve([]); // occupied scan — estate has no conforming tags yet.
      }
      findManyCall += 1;
      return Promise.resolve(affected); // the affected-set read.
    });
    assetTagScheme.updateMany.mockImplementation(
      (a: { data: { nextNumber: number } }) => {
        if (counter < a.data.nextNumber) counter = a.data.nextNumber;
        return Promise.resolve({ count: 1 });
      },
    );
    assetTagScheme.update.mockImplementation(() => {
      counter += 1;
      return Promise.resolve({ nextNumber: counter });
    });
    asset.update.mockResolvedValue({});

    const result = await service.backfillApply({
      mode: 'untagged-only',
      excludeIds: [],
    });

    expect(result).toEqual({ tagged: 2, skipped: 0 });
    expect(findManyCall).toBe(1);
    // Each retag set a fresh sequential tag and recorded an audit row in its transaction.
    expect(asset.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'a1' },
      data: { assetTag: 'IT-1000' },
    });
    expect(asset.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'a2' },
      data: { assetTag: 'IT-1001' },
    });
    expect(history.record).toHaveBeenCalledTimes(2);
    expect(history.record).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        assetId: 'a1',
        eventType: 'SPECS_CHANGED',
        payload: { field: 'assetTag', from: null, to: 'IT-1000' },
      }),
    );
  });

  it('backfillApply (untagged-only) honours excludeIds (per-row deselect)', async () => {
    const affected = [
      { id: 'a1', name: null, serial: null, assetTag: null, modelId: null, model: null },
      { id: 'a2', name: null, serial: null, assetTag: null, modelId: null, model: null },
    ];
    assetTagScheme.findFirst.mockImplementation(() =>
      Promise.resolve({ ...schemeRow(), nextNumber: counter }),
    );
    asset.findMany.mockImplementation((args: { select?: Record<string, unknown> }) => {
      const sel = args.select;
      if (sel && Object.keys(sel).length === 1 && 'assetTag' in sel)
        return Promise.resolve([]);
      return Promise.resolve(affected);
    });
    assetTagScheme.updateMany.mockResolvedValue({ count: 1 });
    assetTagScheme.update.mockImplementation(() => {
      counter += 1;
      return Promise.resolve({ nextNumber: counter });
    });
    asset.update.mockResolvedValue({});

    const result = await service.backfillApply({
      mode: 'untagged-only',
      excludeIds: ['a2'],
    });

    expect(result).toEqual({ tagged: 1, skipped: 1 });
    expect(asset.update).toHaveBeenCalledTimes(1);
    expect(asset.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { assetTag: 'IT-1000' },
    });
  });

  it('backfillApply (normalize-non-conforming) retags NON-conforming but NEVER a conforming tag', async () => {
    // The affected-set read returns ALL live assets (untagged + tagged); the JS conformance filter
    // must keep the untagged + the non-conforming ones and DROP the already-conforming IT-1000.
    const all = [
      { id: 'a1', name: null, serial: null, assetTag: null, modelId: null, model: null }, // untagged
      { id: 'a2', name: null, serial: null, assetTag: 'LEGACY-9', modelId: null, model: null }, // non-conforming
      { id: 'a3', name: null, serial: null, assetTag: 'IT-1000', modelId: null, model: null }, // CONFORMING — skip
    ];
    assetTagScheme.findFirst.mockImplementation(() =>
      Promise.resolve({ ...schemeRow(), nextNumber: counter }),
    );
    asset.findMany.mockImplementation((args: { select?: Record<string, unknown> }) => {
      const sel = args.select;
      if (sel && Object.keys(sel).length === 1 && 'assetTag' in sel) {
        // Occupied scan sees the one conforming tag so the walk skips 1000.
        return Promise.resolve([{ assetTag: 'IT-1000' }]);
      }
      return Promise.resolve(all);
    });
    assetTagScheme.updateMany.mockImplementation(
      (a: { data: { nextNumber: number } }) => {
        if (counter < a.data.nextNumber) counter = a.data.nextNumber;
        return Promise.resolve({ count: 1 });
      },
    );
    assetTagScheme.update.mockImplementation(() => {
      counter += 1;
      return Promise.resolve({ nextNumber: counter });
    });
    asset.update.mockResolvedValue({});

    const result = await service.backfillApply({
      mode: 'normalize-non-conforming',
      excludeIds: [],
    });

    // a1 + a2 retagged; a3 (conforming) untouched and NOT counted as skipped (it was never selected).
    expect(result).toEqual({ tagged: 2, skipped: 0 });
    const updatedIds = asset.update.mock.calls.map((c) => (c[0] as { where: { id: string } }).where.id);
    expect(updatedIds).toEqual(['a1', 'a2']);
    // The IT-1000 slot is occupied, so the walk hands out 1001, 1002 — never re-issuing IT-1000.
    const updatedTags = asset.update.mock.calls.map(
      (c) => (c[0] as { data: { assetTag: string } }).data.assetTag,
    );
    expect(updatedTags).toEqual(['IT-1001', 'IT-1002']);
  });

  it('backfillApply throws a clean 400 when the scheme is DISABLED', async () => {
    assetTagScheme.findFirst.mockResolvedValue({ ...schemeRow({ enabled: false }) });

    await expect(
      service.backfillApply({ mode: 'untagged-only', excludeIds: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(asset.update).not.toHaveBeenCalled();
  });

  // --- backfill preview: read-only, writes nothing, indicative proposed tags --------

  it('backfillPreview projects proposed tags WITHOUT consuming the counter (no jump/consume writes)', async () => {
    const affected = [
      { id: 'a1', name: 'SRV-1', serial: null, assetTag: null, modelId: 'm1', model: { name: 'Dell' } },
      { id: 'a2', name: 'SRV-2', serial: null, assetTag: null, modelId: 'm1', model: { name: 'Dell' } },
    ];
    assetTagScheme.findFirst.mockResolvedValue({ ...schemeRow(), nextNumber: 1000 });
    asset.findMany.mockImplementation((args: { select?: Record<string, unknown> }) => {
      const sel = args.select;
      if (sel && Object.keys(sel).length === 1 && 'assetTag' in sel)
        return Promise.resolve([]); // nothing occupied at/above the counter.
      return Promise.resolve(affected);
    });

    const preview = await service.backfillPreview({
      mode: 'untagged-only',
      page: 1,
      pageSize: 25,
    });

    expect(preview.total).toBe(2);
    expect(preview.items.map((i) => i.proposedTag)).toEqual(['IT-1000', 'IT-1001']);
    expect(preview.items[0]).toMatchObject({
      id: 'a1',
      name: 'SRV-1',
      currentTag: null,
      modelName: 'Dell',
    });
    // CRITICAL: preview writes NOTHING — the counter is never advanced or consumed.
    expect(assetTagScheme.updateMany).not.toHaveBeenCalled();
    expect(assetTagScheme.update).not.toHaveBeenCalled();
    expect(asset.update).not.toHaveBeenCalled();
  });

  // --- nextFreeNumber (pure skip-existing walk) ---------------------------

  it('nextFreeNumber walks past occupied numbers to the first free slot', () => {
    const occupied = new Set([1000, 1002, 1005]);
    expect(nextFreeNumber(occupied, 1000)).toBe(1001);
    expect(nextFreeNumber(occupied, 1002)).toBe(1003);
    expect(nextFreeNumber(occupied, 1003)).toBe(1003);
    expect(nextFreeNumber(occupied, 1005)).toBe(1006);
    // A contiguous block is skipped in full.
    expect(nextFreeNumber(new Set([1, 2, 3, 4]), 1)).toBe(5);
    // Empty set → the floor itself is free.
    expect(nextFreeNumber(new Set(), 42)).toBe(42);
  });

  // --- isUniqueTagCollision (TARGET-AWARE: only the assetTag index advances) ----------------------
  it('matches a P2002 scoped to the assetTag index — both the index-name string and the column-array shape', () => {
    // adapter-pg surfaces the raw partial index by NAME (the real shape for this index).
    expect(
      isUniqueTagCollision(
        new FakePrismaKnownError('P2002', {
          target: 'assets_assetTag_active_key',
        }),
      ),
    ).toBe(true);
    // Defensive: the column-array shape (["assetTag"]) is also recognised.
    expect(
      isUniqueTagCollision(
        new FakePrismaKnownError('P2002', { target: ['assetTag'] }),
      ),
    ).toBe(true);
  });

  it('does NOT match a P2002 on the SERIAL index (a different live partial-unique) — it must propagate', () => {
    expect(
      isUniqueTagCollision(
        new FakePrismaKnownError('P2002', {
          target: 'assets_serial_active_key',
        }),
      ),
    ).toBe(false);
    expect(
      isUniqueTagCollision(
        new FakePrismaKnownError('P2002', { target: ['serial'] }),
      ),
    ).toBe(false);
  });

  it('does NOT match a P2002 with no usable target, a non-P2002, or a non-Prisma error', () => {
    // A bare P2002 (no meta.target) can't be confirmed as the assetTag index → don't retry.
    expect(isUniqueTagCollision(new FakePrismaKnownError('P2002'))).toBe(false);
    expect(isUniqueTagCollision(new FakePrismaKnownError('P2025'))).toBe(false);
    expect(isUniqueTagCollision(new Error('boom'))).toBe(false);
    expect(isUniqueTagCollision(undefined)).toBe(false);
  });
});
