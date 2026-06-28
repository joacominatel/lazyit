import { Test } from '@nestjs/testing';
import { AccessGrantExpirySweeper } from './access-grant-expiry.sweeper';
import { AccessGrantsService } from './access-grants.service';
import { PrismaService } from '../prisma/prisma.service';

// Mock the generated Prisma client so the test never loads the real one (no DB) — same as the other
// access-grants specs. The sweeper only uses Prisma at runtime via the injected mock below.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

type Grant = { id: string; revokedAt: Date | null; expiresAt: Date | null };

const HOUR = 60 * 60 * 1000;

describe('AccessGrantExpirySweeper', () => {
  let sweeper: AccessGrantExpirySweeper;
  let revoke: jest.Mock;
  let findMany: jest.Mock;

  // The world of grants the sweeper queries. findMany applies the sweeper's WHERE against this list so
  // the test exercises the real filter (not-yet-expired / already-revoked are excluded for real).
  const grants: Grant[] = [
    // expired + active → must be revoked
    { id: 'expired', revokedAt: null, expiresAt: new Date(Date.now() - HOUR) },
    // not yet expired + active → must be LEFT ALONE
    { id: 'future', revokedAt: null, expiresAt: new Date(Date.now() + HOUR) },
    // expired but already revoked → must be SKIPPED
    {
      id: 'already-revoked',
      revokedAt: new Date(Date.now() - 2 * HOUR),
      expiresAt: new Date(Date.now() - HOUR),
    },
    // no expiry, active → must be LEFT ALONE
    { id: 'permanent', revokedAt: null, expiresAt: null },
  ];

  beforeEach(async () => {
    revoke = jest.fn().mockResolvedValue({});
    findMany = jest.fn(
      (args: {
        where: { revokedAt: null; expiresAt: { not: null; lt: Date } };
        take: number;
      }) => {
        const now = args.where.expiresAt.lt;
        const matched = grants
          .filter(
            (g) =>
              g.revokedAt === null &&
              g.expiresAt !== null &&
              g.expiresAt.getTime() < now.getTime(),
          )
          .slice(0, args.take)
          .map((g) => ({ id: g.id }));
        return Promise.resolve(matched);
      },
    );

    const moduleRef = await Test.createTestingModule({
      providers: [
        AccessGrantExpirySweeper,
        { provide: PrismaService, useValue: { accessGrant: { findMany } } },
        { provide: AccessGrantsService, useValue: { revoke } },
      ],
    }).compile();

    sweeper = moduleRef.get(AccessGrantExpirySweeper);
  });

  it('auto-revokes only the expired active grant; leaves the rest alone', async () => {
    const count = await sweeper.sweep();

    expect(count).toBe(1);
    expect(revoke).toHaveBeenCalledTimes(1);
    // Revoked through the existing path with an EMPTY body (notes preserved) and an UNDEFINED principal
    // (the system/unknown actor — both actor FKs stay null).
    expect(revoke).toHaveBeenCalledWith('expired', {}, undefined);

    const revokedIds = revoke.mock.calls.map((c: unknown[]) => c[0]);
    expect(revokedIds).not.toContain('future'); // not yet expired
    expect(revokedIds).not.toContain('already-revoked'); // already revoked
    expect(revokedIds).not.toContain('permanent'); // no expiry
  });

  it('does not throw and continues the batch when one grant revoke fails (e.g. concurrent 409)', async () => {
    grants.push({
      id: 'expired-2',
      revokedAt: null,
      expiresAt: new Date(Date.now() - HOUR),
    });
    revoke.mockImplementation((id: string) =>
      id === 'expired' ? Promise.reject(new Error('409')) : Promise.resolve({}),
    );

    const count = await sweeper.sweep();

    // 'expired' threw (skipped), 'expired-2' still revoked → batch survives the per-grant failure.
    expect(count).toBe(1);
    expect(revoke).toHaveBeenCalledWith('expired-2', {}, undefined);
    grants.pop();
  });
});
