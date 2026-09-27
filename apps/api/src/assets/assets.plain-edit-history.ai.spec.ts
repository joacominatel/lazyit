// The generated Prisma client is only used for types here; keep the real one from loading (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

import { runInAiInvocation } from '../ai/core/invocation-context';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { ActorService } from '../common/actor.service';
import { AssetsService } from './assets.service';

/**
 * A plain asset edit made by the AI (#1382): the `asset_update` tool and each row of `asset_update_batch`
 * dispatch to the same PATCH route, so they land on `AssetsService.update` inside the AI invocation
 * context. Wired to the REAL AssetHistoryService, the UPDATED row it writes carries the invocation's
 * `aiInvocationId` (ADR-0097 decision 11) alongside the acting principal.
 */
describe('AssetsService.update — plain edits through the AI path', () => {
  const ACTOR_ID = '11111111-1111-1111-1111-111111111111';
  const PRINCIPAL = { kind: 'human', user: { id: ACTOR_ID } } as never;

  let rows: Map<string, Record<string, unknown>>;
  let written: Array<Record<string, unknown>>;
  let service: AssetsService;

  beforeEach(() => {
    rows = new Map(
      ['a1', 'a2', 'a3'].map((id) => [
        id,
        {
          id,
          name: `Asset ${id}`,
          notes: null,
          status: 'OPERATIONAL',
          locationId: null,
          modelId: null,
          specs: null,
        },
      ]),
    );
    written = [];
    const tx = {
      asset: {
        update: jest.fn(
          ({ where, data }: { where: { id: string }; data: object }) => {
            const next = { ...rows.get(where.id), ...data };
            rows.set(where.id, next);
            return Promise.resolve(next);
          },
        ),
      },
      assetHistory: {
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          written.push(data);
          return Promise.resolve({});
        }),
      },
    };
    const prisma = {
      asset: {
        findFirst: jest.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve(
            rows.has(where.id) ? { ...rows.get(where.id) } : null,
          ),
        ),
      },
      $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    service = new AssetsService(
      prisma as never,
      new ActorService(),
      new AssetHistoryService(prisma as never),
      { upsert: jest.fn() } as never,
      {} as never,
    );
  });

  it('asset_update: the UPDATED row names the fields and carries the aiInvocationId and the actor', async () => {
    await runInAiInvocation(
      { invocationId: 'inv-single', channel: 'HEADLESS' },
      () => service.update('a1', { notes: 'moved desks' }, PRINCIPAL),
    );

    expect(written).toEqual([
      {
        assetId: 'a1',
        eventType: 'UPDATED',
        payload: { fields: ['notes'] },
        performedById: ACTOR_ID,
        aiInvocationId: 'inv-single',
      },
    ]);
  });

  it('asset_update_batch: one UPDATED row per changed asset, all under the batch invocation; an unchanged row writes none', async () => {
    await runInAiInvocation(
      { invocationId: 'inv-batch', channel: 'MCP' },
      async () => {
        await service.update('a1', { name: 'Renamed 1' }, PRINCIPAL);
        await service.update('a2', { name: 'Asset a2' }, PRINCIPAL); // no-op
        await service.update(
          'a3',
          { name: 'Renamed 3', status: 'IN_STORAGE' },
          PRINCIPAL,
        );
      },
    );

    expect(
      written.map((r) => [r.assetId, r.eventType, r.payload, r.aiInvocationId]),
    ).toEqual([
      ['a1', 'UPDATED', { fields: ['name'] }, 'inv-batch'],
      [
        'a3',
        'STATUS_CHANGED',
        { from: 'OPERATIONAL', to: 'IN_STORAGE' },
        'inv-batch',
      ],
      ['a3', 'UPDATED', { fields: ['name'] }, 'inv-batch'],
    ]);
  });

  it('outside an AI call the UPDATED row carries no aiInvocationId', async () => {
    await service.update('a1', { notes: 'by hand' }, PRINCIPAL);

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      eventType: 'UPDATED',
      payload: { fields: ['notes'] },
    });
    expect(written[0]).not.toHaveProperty('aiInvocationId');
  });
});
