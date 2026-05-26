import { Test } from '@nestjs/testing';
import { AssetHistoryService } from './asset-history.service';
import { PrismaService } from '../prisma/prisma.service';

// Mock the generated Prisma client so the test never loads the real one (no DB). The service uses
// `Prisma` only for types (erased at runtime), so an empty object is enough.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

// Shape the create call is cast to, so assertions stay type-safe (no-unsafe-* lint).
type CreateCall = [{ data: Record<string, unknown> }];

const ACTOR_ID = '11111111-1111-1111-1111-111111111111';

describe('AssetHistoryService', () => {
  let service: AssetHistoryService;
  let assetHistory: { findMany: jest.Mock };

  beforeEach(async () => {
    // `list` reads through the injected PrismaService; `record` writes through the client it is
    // given (a transaction client at runtime), so it is exercised with a standalone mock writer.
    assetHistory = { findMany: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssetHistoryService,
        { provide: PrismaService, useValue: { assetHistory } },
      ],
    }).compile();

    service = moduleRef.get(AssetHistoryService);
  });

  // --- record (writes through the passed-in client) -----------------------
  it('appends a row through the given client with all fields when payload + actor are present', async () => {
    const client = {
      assetHistory: { create: jest.fn().mockResolvedValue({}) },
    };

    await service.record(client, {
      assetId: 'a1',
      eventType: 'STATUS_CHANGED',
      payload: { from: 'OPERATIONAL', to: 'RETIRED' },
      performedById: ACTOR_ID,
    });

    expect(client.assetHistory.create).toHaveBeenCalledWith({
      data: {
        assetId: 'a1',
        eventType: 'STATUS_CHANGED',
        payload: { from: 'OPERATIONAL', to: 'RETIRED' },
        performedById: ACTOR_ID,
      },
    });
  });

  it('omits payload and performedById from the row when they are not given', async () => {
    const client = {
      assetHistory: { create: jest.fn().mockResolvedValue({}) },
    };

    await service.record(client, { assetId: 'a1', eventType: 'CREATED' });

    const calls = client.assetHistory.create.mock.calls as CreateCall[];
    expect(calls[0][0].data).toEqual({ assetId: 'a1', eventType: 'CREATED' });
    expect(calls[0][0].data).not.toHaveProperty('payload');
    expect(calls[0][0].data).not.toHaveProperty('performedById');
  });

  it('omits performedById when the actor is undefined (system event) but keeps the payload', async () => {
    const client = {
      assetHistory: { create: jest.fn().mockResolvedValue({}) },
    };

    await service.record(client, {
      assetId: 'a1',
      eventType: 'ASSIGNED',
      payload: { userId: 'u1' },
      performedById: undefined,
    });

    const calls = client.assetHistory.create.mock.calls as CreateCall[];
    expect(calls[0][0].data).toEqual({
      assetId: 'a1',
      eventType: 'ASSIGNED',
      payload: { userId: 'u1' },
    });
    expect(calls[0][0].data).not.toHaveProperty('performedById');
  });

  // --- list (reads through PrismaService) ---------------------------------
  it('lists an asset history page newest-first, capped by limit (no cursor)', async () => {
    assetHistory.findMany.mockResolvedValue([]);

    await service.list('a1', { limit: 50 });

    expect(assetHistory.findMany).toHaveBeenCalledWith({
      where: { assetId: 'a1' },
      orderBy: { id: 'desc' },
      take: 50,
    });
  });

  it('adds the exclusive id cursor (id < before) when `before` is given', async () => {
    assetHistory.findMany.mockResolvedValue([]);

    await service.list('a1', { limit: 25, before: 100 });

    expect(assetHistory.findMany).toHaveBeenCalledWith({
      where: { assetId: 'a1', id: { lt: 100 } },
      orderBy: { id: 'desc' },
      take: 25,
    });
  });
});
