import { Test } from '@nestjs/testing';

// The controller transitively loads AssetTagSchemeService → the generated Prisma client. Stub it
// (the service is replaced by a mock below; this only stops the real module from loading).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));

import { AssetTagSchemeController } from './asset-tag-scheme.controller';
import { AssetTagSchemeService } from './asset-tag-scheme.service';
import type { AssetTagScheme } from '@lazyit/shared';

describe('AssetTagSchemeController', () => {
  let controller: AssetTagSchemeController;
  let service: {
    getScheme: jest.Mock;
    updateScheme: jest.Mock;
    seedSuggestion: jest.Mock;
    backfillPreview: jest.Mock;
    backfillApply: jest.Mock;
  };

  const SCHEME: AssetTagScheme = {
    prefix: 'LAZY-',
    suffix: null,
    width: 5,
    nextNumber: 42,
    enabled: true,
    createdAt: '2026-06-16T00:00:00.000Z',
    updatedAt: '2026-06-16T00:00:00.000Z',
  };

  beforeEach(async () => {
    service = {
      getScheme: jest.fn().mockResolvedValue(SCHEME),
      updateScheme: jest.fn().mockResolvedValue(SCHEME),
      seedSuggestion: jest.fn().mockResolvedValue({
        suggestedStartNumber: 1006,
        matchedCount: 3,
        maxExistingNumber: 1005,
      }),
      backfillPreview: jest.fn().mockResolvedValue({
        items: [],
        total: 0,
        page: 1,
        pageSize: 25,
        mode: 'untagged-only',
      }),
      backfillApply: jest.fn().mockResolvedValue({ tagged: 2, skipped: 0 }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [AssetTagSchemeController],
      providers: [{ provide: AssetTagSchemeService, useValue: service }],
    }).compile();
    controller = moduleRef.get(AssetTagSchemeController);
  });

  it('GET delegates to getScheme', async () => {
    await expect(controller.get()).resolves.toEqual(SCHEME);
    expect(service.getScheme).toHaveBeenCalledTimes(1);
  });

  it('PUT delegates the validated body to updateScheme', async () => {
    const body = { enabled: true, prefix: 'LAZY-', width: 5, startNumber: 42 };
    await expect(controller.update(body)).resolves.toEqual(SCHEME);
    expect(service.updateScheme).toHaveBeenCalledWith(body);
  });

  it('GET seed-suggestion delegates the in-progress affixes', async () => {
    const query = { prefix: 'IT-', suffix: undefined, width: undefined };
    const result = await controller.seedSuggestion(query);
    expect(result.suggestedStartNumber).toBe(1006);
    expect(service.seedSuggestion).toHaveBeenCalledWith(query);
  });

  it('GET backfill/preview delegates the query', async () => {
    const query = { mode: 'untagged-only' as const, page: 1, pageSize: 25 };
    await controller.backfillPreview(query);
    expect(service.backfillPreview).toHaveBeenCalledWith(query);
  });

  it('POST backfill/apply delegates the body + principal', async () => {
    const body = { mode: 'normalize-non-conforming' as const, excludeIds: ['a2'] };
    const principal = { kind: 'human', user: { id: 'u1' } } as never;
    await expect(controller.backfillApply(body, principal)).resolves.toEqual({
      tagged: 2,
      skipped: 0,
    });
    expect(service.backfillApply).toHaveBeenCalledWith(body, principal);
  });
});
