import { Test } from '@nestjs/testing';
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
} from './asset-tag-scheme.service';

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
};

// The shape of the upsert() arg, so the assertions stay type-safe (no-unsafe-member-access).
type UpsertArg = {
  where: { id: string };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
};

describe('AssetTagSchemeService', () => {
  let service: AssetTagSchemeService;
  let assetTagScheme: SchemeMock;

  const SINGLETON = AssetTagSchemeService.SINGLETON_ID;

  beforeEach(async () => {
    assetTagScheme = {
      findFirst: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AssetTagSchemeService,
        { provide: PrismaService, useValue: { assetTagScheme } },
      ],
    }).compile();
    service = moduleRef.get(AssetTagSchemeService);
  });

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
