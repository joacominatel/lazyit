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
  let service: { getScheme: jest.Mock; updateScheme: jest.Mock };

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
});
