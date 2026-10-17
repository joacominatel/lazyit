jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import { GrantInactiveError, RunContextBuilder } from './run-context';
import type { PrismaService } from '../../prisma/prisma.service';

const LIVE_USER = {
  id: 'u1',
  email: 'ada@example.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  legajo: null,
  username: null,
  managerName: null,
  manager: null,
  deletedAt: null as Date | null,
};

function builderFor(opts: {
  trigger: 'ACCESS_GRANTED' | 'ACCESS_REVOKED';
  revokedAt?: Date | null;
  userDeletedAt?: Date | null;
}) {
  const prisma = {
    workflowRun: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'run1',
        trigger: opts.trigger,
        application: { id: 'app1', name: 'Jira' },
        accessGrant: {
          id: 'g1',
          accessLevel: null,
          grantedAt: new Date('2026-01-01T00:00:00.000Z'),
          expiresAt: null,
          revokedAt: opts.revokedAt ?? null,
          user: { ...LIVE_USER, deletedAt: opts.userDeletedAt ?? null },
        },
      }),
    },
    manualTask: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
  return new RunContextBuilder(prisma);
}

describe('RunContextBuilder — inactive grants never provision (AUD-069)', () => {
  it('refuses a provisioning run whose grant was revoked', async () => {
    const builder = builderFor({
      trigger: 'ACCESS_GRANTED',
      revokedAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    await expect(builder.build('run1')).rejects.toBeInstanceOf(
      GrantInactiveError,
    );
  });

  it('refuses a provisioning run whose grantee was offboarded', async () => {
    const builder = builderFor({
      trigger: 'ACCESS_GRANTED',
      userDeletedAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    await expect(builder.build('run1')).rejects.toBeInstanceOf(
      GrantInactiveError,
    );
  });

  it('builds the context for a live grant', async () => {
    const ctx = await builderFor({ trigger: 'ACCESS_GRANTED' }).build('run1');
    expect(ctx.grantee.email).toBe('ada@example.test');
    expect(ctx.grant.id).toBe('g1');
  });

  it('still builds the context for a deprovisioning run, whose grant is revoked by definition', async () => {
    const ctx = await builderFor({
      trigger: 'ACCESS_REVOKED',
      revokedAt: new Date('2026-02-01T00:00:00.000Z'),
      userDeletedAt: new Date('2026-02-01T00:00:00.000Z'),
    }).build('run1');
    expect(ctx.event).toBe('ACCESS_REVOKED');
  });
});
