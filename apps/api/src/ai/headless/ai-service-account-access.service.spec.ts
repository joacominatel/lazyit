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

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PermissionResolverService } from '../../auth/permission-resolver.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { withSoftDeleteFilter } from '../../prisma/soft-delete.extension';
import { AiServiceAccountAccessService } from './ai-service-account-access.service';

type Row = Record<string, unknown>;

const LIVE = 'cksalive0000000000000001';
const REVOKED = 'cksarevoked0000000000001';

/** Service-account reads as the soft-delete extension shapes them: `findUnique` is never filtered. */
function fakePrisma(
  stored: Row | null = null,
  grants: string[] = ['asset:read', 'asset:write'],
) {
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
      findUnique: jest.fn(() => Promise.resolve(stored)),
      upsert: jest.fn(({ create }: { create: Row }) => {
        settings.push(create);
        return Promise.resolve(create);
      }),
    },
    serviceAccountPermission: {
      findMany: jest.fn(() =>
        Promise.resolve(grants.map((permission) => ({ permission }))),
      ),
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

// A MEMBER role delegated settings:manage, holding asset:read but not asset:write.
const resolver = {
  resolve: () => Promise.resolve(new Set(['settings:manage', 'asset:read'])),
} as unknown as PermissionResolverService;

describe('AiServiceAccountAccessService (AUD-079)', () => {
  it('a revoked Service Account is not found: its setting is neither read nor written', async () => {
    const { prisma, settings, audit } = fakePrisma();
    const service = new AiServiceAccountAccessService(
      prisma as unknown as PrismaService,
      resolver,
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
      resolver,
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

describe('AiServiceAccountAccessService — widening stays within the caller (SEC-088)', () => {
  const off = { serviceAccountId: LIVE, access: 'off', maxMutationsPerRun: 2 };

  it.each([
    ['a higher access level', { access: 'read-write', maxMutationsPerRun: 2 }],
    ['a higher cap', { access: 'off', maxMutationsPerRun: 5 }],
    ['a cleared cap', { access: 'off', maxMutationsPerRun: null }],
  ] as const)(
    'a delegated MEMBER is refused %s on an over-ceiling account; nothing is written',
    async (_label, next) => {
      const { prisma, settings, audit } = fakePrisma(off);
      const service = new AiServiceAccountAccessService(
        prisma as unknown as PrismaService,
        resolver,
      );
      const err = await service
        .update(LIVE, next, 'member-1', 'MEMBER')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err).toMatchObject({
        response: {
          code: 'PERMISSION_CEILING_EXCEEDED',
          permissions: ['asset:write'],
        },
      });
      expect(settings).toHaveLength(0);
      expect(audit).toHaveLength(0);
    },
  );

  it('infra:report is exempt from the ceiling when widening', async () => {
    const { prisma, settings } = fakePrisma(off, ['infra:report']);
    await new AiServiceAccountAccessService(
      prisma as unknown as PrismaService,
      resolver,
    ).update(
      LIVE,
      { access: 'read-write', maxMutationsPerRun: null },
      'member-1',
      'MEMBER',
    );
    expect(settings).toHaveLength(1);
  });

  it('narrowing an over-ceiling account is always allowed', async () => {
    const { prisma, settings } = fakePrisma({
      ...off,
      access: 'read-write',
      maxMutationsPerRun: null,
    });
    const service = new AiServiceAccountAccessService(
      prisma as unknown as PrismaService,
      resolver,
    );
    await service.update(
      LIVE,
      { access: 'read-only', maxMutationsPerRun: 3 },
      'member-1',
      'MEMBER',
    );
    expect(settings).toHaveLength(1);
  });

  it('widening is allowed within the caller, and for an ADMIN on any account', async () => {
    const within = fakePrisma(off, ['asset:read', 'settings:manage']);
    await new AiServiceAccountAccessService(
      within.prisma as unknown as PrismaService,
      resolver,
    ).update(
      LIVE,
      { access: 'read-write', maxMutationsPerRun: null },
      'member-1',
      'MEMBER',
    );
    expect(within.settings).toHaveLength(1);

    const admin = fakePrisma(off);
    await new AiServiceAccountAccessService(
      admin.prisma as unknown as PrismaService,
      resolver,
    ).update(
      LIVE,
      { access: 'read-write', maxMutationsPerRun: null },
      'admin-1',
      'ADMIN',
    );
    expect(admin.settings).toHaveLength(1);
  });
});
