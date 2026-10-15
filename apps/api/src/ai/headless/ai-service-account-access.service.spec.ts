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

import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import { withSoftDeleteFilter } from '../../prisma/soft-delete.extension';
import { AiServiceAccountAccessService } from './ai-service-account-access.service';

type Row = Record<string, unknown>;

const LIVE = 'cksalive0000000000000001';
const REVOKED = 'cksarevoked0000000000001';

/** Service-account reads as the soft-delete extension shapes them: `findUnique` is never filtered. */
function fakePrisma() {
  const accounts: Row[] = [
    { id: LIVE, deletedAt: null },
    { id: REVOKED, deletedAt: new Date('2026-09-01T00:00:00.000Z') },
  ];
  const read = (operation: string) => (args: unknown) => {
    const { where = {} } = withSoftDeleteFilter(
      'ServiceAccount',
      operation,
      args,
    ) as { where?: Row };
    const hit = accounts.find((a) =>
      Object.entries(where).every(([key, value]) => a[key] === value),
    );
    return Promise.resolve(hit ? { id: hit.id } : null);
  };
  const settings: Row[] = [];
  const audit: Row[] = [];
  const prisma = {
    serviceAccount: {
      findUnique: jest.fn(read('findUnique')),
      findFirst: jest.fn(read('findFirst')),
    },
    aiServiceAccountSettings: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      upsert: jest.fn(({ create }: { create: Row }) => {
        settings.push(create);
        return Promise.resolve(create);
      }),
    },
    aiConfigAuditLog: {
      create: jest.fn(({ data }: { data: Row }) => {
        audit.push(data);
        return Promise.resolve(data);
      }),
    },
    $transaction: (run: (tx: unknown) => Promise<unknown>) => run(prisma),
  };
  return { prisma, settings, audit };
}

describe('AiServiceAccountAccessService (AUD-079)', () => {
  it('a revoked Service Account is not found: its setting is neither read nor written', async () => {
    const { prisma, settings, audit } = fakePrisma();
    const service = new AiServiceAccountAccessService(
      prisma as unknown as PrismaService,
    );
    await expect(service.get(REVOKED)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.update(
        REVOKED,
        { access: 'off', maxMutationsPerRun: null },
        null,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(settings).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });

  it('a live one is read and updated', async () => {
    const { prisma, settings } = fakePrisma();
    const service = new AiServiceAccountAccessService(
      prisma as unknown as PrismaService,
    );
    await expect(service.get(LIVE)).resolves.toEqual({
      access: 'read-write',
      maxMutationsPerRun: null,
    });
    await service.update(
      LIVE,
      { access: 'off', maxMutationsPerRun: null },
      null,
    );
    expect(settings).toEqual([
      { serviceAccountId: LIVE, access: 'off', maxMutationsPerRun: null },
    ]);
  });
});
